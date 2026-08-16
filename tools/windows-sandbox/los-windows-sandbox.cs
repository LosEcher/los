// los-windows-sandbox.cs — zero-elevation write-restriction sandbox launcher for los.
//
// STATUS: DRAFT — NOT DEPLOYED. The WRITE_RESTRICTED intersection semantics
// (which ambient ACEs the logon/World restricting SIDs pick up) need a real
// validation battery on a Windows node before this may run agent commands.
// Kept as the scoped follow-up for enabling L2 shell on the Windows node
// (los node class desktop-r45553o, Win10 Pro 26200).
//
// argv contract (argv-prefix runner, same shape as bwrap/sandbox-exec):
//   los-windows-sandbox.exe --workspace <dir> --mode <read-only|workspace-write> -- <argv...>
//
// Mechanism (mirrors @deepseek-ai/dsh-sandbox-windows-acl / OpenAI Codex "unelevated"):
//   1. Open the caller's process token and mint a WRITE_RESTRICTED token whose
//      restricting SIDs are {logon SID, World SID, workspaceCapSID}. The cap SID is
//      a deterministic S-1-4-x-y derived from the canonical workspace path; it has
//      power only through the ACEs that name it.
//   2. In workspace-write mode, add an inheritable Write ACE for the cap SID on the
//      workspace root (standing; exact-ACE skip). In read-only mode, no grants are
//      made, so writes are denied everywhere the ambient write ACEs do not apply.
//   3. Set the restricted token's default DACL to allow the cap SID (or World under
//      read-only) so anonymous stdio pipes created by the child pass the write
//      access check (without this, piped capture fails with EPERM).
//   4. Spawn the command via CreateProcessAsUser with redirected stdio, inside a
//      kill-on-close Job Object; mirror the child's exit code and captured output.
//   5. Fail closed: ANY Win32 failure before spawn aborts with a non-zero exit and
//      an error line on stderr; the child is never spawned unrestricted.
//
// Build (no external toolchain; csc ships with .NET Framework on every Win10+):
//   csc /nologo /platform:anycpu /target:exe /out:los-windows-sandbox.exe los-windows-sandbox.cs

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

internal static class Program
{
    // ── Win32 constants ──────────────────────────────────────────────
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    private const uint TOKEN_ALL_ACCESS = 0x000F01FF;
    private const uint DISABLE_MAX_PRIVILEGE = 0x0001;
    private const uint SANDBOX_INERT = 0x0002;
    private const uint WRITE_RESTRICTED = 0x0800;
    private const int TokenUser = 1;
    private const int TokenDefaultDacl = 6;
    private const int TokenPrimary = 1; // TOKEN_INFORMATION_CLASS::TokenPrimary
    private const int TokenStatistics = 10;
    private const uint SECURITY_DESCRIPTOR_REVISION = 1;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const uint PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000;
    private const uint ACL_REVISION = 2;
    private const uint ACCESS_ALLOWED_ACE_TYPE = 0x00;
    private const uint CONTAINER_INHERIT_ACE = 0x02;
    private const uint OBJECT_INHERIT_ACE = 0x01;
    private const uint GENERIC_ALL = 0x10000000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint GENERIC_EXECUTE = 0x20000000;
    private const uint FILE_GENERIC_WRITE = 0x00120116;
    private const uint FILE_GENERIC_READ = 0x00120089;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int STILL_ACTIVE = 259;

    // ── Structures ───────────────────────────────────────────────────
    [StructLayout(LayoutKind.Sequential)]
    private struct LUID { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)]
    private struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privileges; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_USER { public IntPtr User; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ACL { public byte AclRevision; public byte Sbz1; public ushort AclSize; public ushort AceCount; public ushort Sbz2; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ACE_HEADER { public byte AceType; public byte AceFlags; public ushort AceSize; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ACCESS_ALLOWED_ACE { public ACE_HEADER Header; public uint Mask; public uint SidStart; }
    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_DESCRIPTOR { public byte Revision; public byte Sbz1; public ushort Control; public IntPtr Owner; public IntPtr Group; public IntPtr Sacl; public IntPtr Dacl; }
    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public uint nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
        public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags;
        public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }

    // ── P/Invoke ─────────────────────────────────────────────────────
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr ExistingTokenHandle, uint Flags, uint DisableSidCount, IntPtr SidsToDisable, uint DeletePrivilegeCount, IntPtr PrivilegesToDelete, uint RestrictedSidCount, IntPtr SidsToRestrict, out IntPtr NewTokenHandle);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertStringSidToSid(string StringSid, out IntPtr Sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateWellKnownSid(int WellKnownSidType, IntPtr DomainSid, IntPtr pSid, ref uint cbSid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AllocateAndInitializeSid(IntPtr pIdentifierAuthority, byte nSubAuthorityCount, uint nSubAuthority0, uint nSubAuthority1, uint nSubAuthority2, uint nSubAuthority3, uint nSubAuthority4, uint nSubAuthority5, uint nSubAuthority6, uint nSubAuthority7, out IntPtr pSid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetSecurityInfo(IntPtr handle, int ObjectType, uint SecurityInfo, out IntPtr ppsidOwner, out IntPtr ppsidGroup, out IntPtr ppDacl, out IntPtr ppSacl, out IntPtr ppSecurityDescriptor);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint SetSecurityInfo(IntPtr handle, int ObjectType, uint SecurityInfo, IntPtr psidOwner, IntPtr psidGroup, IntPtr pDacl, IntPtr pSacl);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool InitializeAcl(IntPtr pAcl, uint nAclLength, uint dwAclRevision);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AddAccessAllowedAceEx(IntPtr pAcl, uint dwAceRevision, uint AceFlags, uint AccessMask, IntPtr pSid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetAclInformation(IntPtr pAcl, IntPtr pAclInformation, uint nAclInformationLength, int dwAclInformationClass);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool IsValidSid(IntPtr pSid);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, IntPtr lpPipeAttributes, uint nSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation2(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength, out uint ReturnLength);

    private const int HANDLE_FLAG_INHERIT = 0x1;
    private const int SE_FILE_OBJECT = 1;

    // ── Helpers ──────────────────────────────────────────────────────
    private static int Fail(string message)
    {
        Console.Error.WriteLine("los-windows-sandbox: " + message);
        return 127;
    }

    private static int Win32Fail(string what)
    {
        return Fail(what + " failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message + " (0x" + Marshal.GetLastWin32Error().ToString("X8") + ")");
    }

    private static IntPtr DuplicateSid(IntPtr sid)
    {
        // Copy the SID bytes into a fresh allocation so the caller owns it.
        if (!IsValidSid(sid)) throw new InvalidOperationException("invalid sid");
        int len = GetLengthSid(sid);
        IntPtr copy = Marshal.AllocHGlobal(len);
        if (!CopySid((uint)len, copy, sid)) { Marshal.FreeHGlobal(copy); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        return copy;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern int GetLengthSid(IntPtr pSid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CopySid(uint nDestinationSidLength, IntPtr pDestinationSid, IntPtr pSourceSid);

    private static string SidString(IntPtr sid)
    {
        IntPtr str;
        if (!ConvertSidToStringSid(sid, out str)) return "?";
        string s = Marshal.PtrToStringUni(str);
        LocalFree(str);
        return s;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSidToStringSid(IntPtr Sid, out IntPtr StringSid);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    // Derive the deterministic workspace capability SID (S-1-4-x-y), same
    // scheme as @deepseek-ai/dsh-sandbox-windows-acl workspaceWriteSid.
    private static string WorkspaceCapSid(string workspaceRoot)
    {
        byte[] digest;
        using (var sha = System.Security.Cryptography.SHA256.Create())
            digest = sha.ComputeHash(Encoding.UTF8.GetBytes(workspaceRoot));
        uint first = (BitConverter.ToUInt32(digest, 0) % (uint)((1 << 30) - 1)) + 1;
        uint second = (BitConverter.ToUInt32(digest, 4) % (uint)((1 << 30) - 1)) + 1;
        return "S-1-4-" + first + "-" + second;
    }

    private static IntPtr GetLogonSid(IntPtr token)
    {
        // TokenGroups → find the Logon SID (S-1-5-5-*)
        uint len;
        GetTokenInformation(token, 2 /*TokenGroups*/, IntPtr.Zero, 0, out len);
        IntPtr buf = Marshal.AllocHGlobal((int)len);
        try
        {
            if (!GetTokenInformation(token, 2, buf, len, out len)) throw new Win32Exception(Marshal.GetLastWin32Error());
            // TOKEN_GROUPS layout: DWORD GroupCount; SID_AND_ATTRIBUTES Groups[count]
            int count = Marshal.ReadInt32(buf);
            int stride = Marshal.SizeOf(typeof(SidAndAttributes));
            for (int i = 0; i < count; i++)
            {
                IntPtr entry = IntPtr.Add(buf, 4 + i * stride);
                SidAndAttributes sa = (SidAndAttributes)Marshal.PtrToStructure(entry, typeof(SidAndAttributes));
                string s = SidString(sa.Sid);
                if (s.StartsWith("S-1-5-5-")) return DuplicateSid(sa.Sid);
            }
            throw new InvalidOperationException("logon sid not found");
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }

    private static IntPtr BuildDaclWithGrant(IntPtr capSid, bool grantCap, bool readOnly)
    {
        // Allocate a fresh DACL: world read in read-only? Keep minimal:
        // workspace-write → cap SID gets inheritable GENERIC_ALL (write+read) on the
        // workspace; read-only → no grants (child can still read via Everyone/user ACEs).
        uint aclSize = (uint)(Marshal.SizeOf(typeof(ACL)) + Marshal.SizeOf(typeof(ACCESS_ALLOWED_ACE)) + 64);
        IntPtr acl = Marshal.AllocHGlobal((int)aclSize);
        if (!InitializeAcl(acl, aclSize, ACL_REVISION)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (grantCap && capSid != IntPtr.Zero)
        {
            uint flags = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;
            if (!AddAccessAllowedAceEx(acl, ACL_REVISION, flags, GENERIC_ALL, capSid))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return acl;
    }

    private static bool GrantWorkspaceWrite(IntPtr capSid, string workspaceRoot)
    {
        // Add an inheritable GENERIC_ALL ACE for the cap SID to the workspace root DACL.
        // We rebuild the DACL: read current, append our ACE, write back.
        IntPtr owner, group, dacl, sacl, sd;
        if (!GetSecurityInfo(CreateFileHandle(workspaceRoot), SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION, out owner, out group, out dacl, out sacl, out sd))
            throw new Win32Exception(Marshal.GetLastWin32Error());

        // Measure the current ACL and allocate room for one more ACE.
        uint curLen = 0;
        if (dacl != IntPtr.Zero) { ACL acl = (ACL)Marshal.PtrToStructure(dacl, typeof(ACL)); curLen = acl.AclSize; }
        uint newLen = curLen + (uint)(Marshal.SizeOf(typeof(ACCESS_ALLOWED_ACE)) + 64);
        IntPtr newDacl = Marshal.AllocHGlobal((int)newLen);
        if (!InitializeAcl(newDacl, newLen, ACL_REVISION)) throw new Win32Exception(Marshal.GetLastWin32Error());
        // Copy existing ACEs
        if (dacl != IntPtr.Zero)
        {
            ACL acl = (ACL)Marshal.PtrToStructure(dacl, typeof(ACL));
            int offset = Marshal.SizeOf(typeof(ACL));
            for (ushort i = 0; i < acl.AceCount; i++)
            {
                ACE_HEADER hdr = (ACE_HEADER)Marshal.PtrToStructure(IntPtr.Add(dacl, offset), typeof(ACE_HEADER));
                IntPtr ace = Marshal.AllocHGlobal(hdr.AceSize);
                try { CopyMemory(ace, IntPtr.Add(dacl, offset), hdr.AceSize); AppendAce(newDacl, ace, hdr.AceSize); }
                finally { Marshal.FreeHGlobal(ace); }
                offset += hdr.AceSize;
            }
        }
        uint flags = CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE;
        if (!AddAccessAllowedAceEx(newDacl, ACL_REVISION, flags, GENERIC_ALL, capSid))
            throw new Win32Exception(Marshal.GetLastWin32Error());

        uint res = SetSecurityInfo(CreateFileHandle(workspaceRoot), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, newDacl, IntPtr.Zero);
        if (res != 0) throw new Win32Exception((int)res);
        return true;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    private const uint FILE_READ_ATTRIBUTES = 0x0080;
    private const uint FILE_WRITE_DAC = 0x00040000;
    private const uint FILE_SHARE_READ_WRITE_DELETE = 0x7;
    private const uint OPEN_EXISTING = 3;
    private static IntPtr _wsHandle;
    private static IntPtr CreateFileHandle(string path)
    {
        if (_wsHandle == IntPtr.Zero)
            _wsHandle = CreateFile(path, FILE_READ_ATTRIBUTES | FILE_WRITE_DAC, FILE_SHARE_READ_WRITE_DELETE, IntPtr.Zero, OPEN_EXISTING, 0x02000000 /*FILE_FLAG_BACKUP_SEMANTICS*/, IntPtr.Zero);
        if (_wsHandle == IntPtr.Zero || _wsHandle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return _wsHandle;
    }

    [DllImport("kernel32.dll")]
    private static extern void CopyMemory(IntPtr dest, IntPtr src, int count);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AddAce(IntPtr pAcl, uint dwAceRevision, uint dwStartingAceIndex, IntPtr pAceList, uint nAceListLength);
    private static void AppendAce(IntPtr acl, IntPtr ace, int size)
    {
        uint idx = 0xFFFFFFFF; // MAXDWORD → append
        if (!AddAce(acl, ACL_REVISION, idx, ace, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    private static void SetDefaultDacl(IntPtr token, IntPtr capSid, bool grantCap)
    {
        // TokenDefaultDacl: struct { ACL DefaultDacl; } — build an ACL with one
        // full-access ACE for the cap SID (or World under read-only) so the
        // child's anonymous pipes pass the write pass-2 check.
        uint aclSize = (uint)(Marshal.SizeOf(typeof(ACL)) + Marshal.SizeOf(typeof(ACCESS_ALLOWED_ACE)) + 64);
        IntPtr acl = Marshal.AllocHGlobal((int)aclSize);
        try
        {
            if (!InitializeAcl(acl, aclSize, ACL_REVISION)) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr grant = grantCap ? capSid : GetWorldSid();
            if (!AddAccessAllowedAceEx(acl, ACL_REVISION, 0, GENERIC_ALL, grant)) throw new Win32Exception(Marshal.GetLastWin32Error());
            // The token information buffer is an ACL.
            if (!SetTokenInformation(token, TokenDefaultDacl, acl, aclSize)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { Marshal.FreeHGlobal(acl); }
    }

    private static IntPtr _worldSid;
    private static IntPtr GetWorldSid()
    {
        if (_worldSid == IntPtr.Zero)
        {
            uint len = 0;
            CreateWellKnownSid(1 /*WinWorldSid*/, IntPtr.Zero, IntPtr.Zero, ref len);
            IntPtr sid = Marshal.AllocHGlobal((int)len);
            if (!CreateWellKnownSid(1, IntPtr.Zero, sid, ref len)) throw new Win32Exception(Marshal.GetLastWin32Error());
            _worldSid = sid;
        }
        return _worldSid;
    }

    // ── Main ─────────────────────────────────────────────────────────
    public static int Main(string[] args)
    {
        string workspace = null;
        string mode = "workspace-write";
        int i = 0;
        while (i < args.Length)
        {
            if (args[i] == "--workspace" && i + 1 < args.Length) { workspace = args[i + 1]; i += 2; }
            else if (args[i] == "--mode" && i + 1 < args.Length) { mode = args[i + 1]; i += 2; }
            else if (args[i] == "--") { i++; break; }
            else { return Fail("unexpected argument: " + args[i]); }
        }
        if (workspace == null) return Fail("--workspace is required");
        bool readOnly = mode == "read-only";
        if (!readOnly && mode != "workspace-write") return Fail("--mode must be read-only or workspace-write");
        if (i >= args.Length) return Fail("no command after --");

        string commandLine = BuildCommandLine(args, i);

        IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero, logonSid = IntPtr.Zero, capSid = IntPtr.Zero;
        IntPtr job = IntPtr.Zero, hOutRead = IntPtr.Zero, hOutWrite = IntPtr.Zero, hErrRead = IntPtr.Zero, hErrWrite = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out token))
                return Win32Fail("OpenProcessToken");
            logonSid = GetLogonSid(token);

            string capSidStr = WorkspaceCapSid(Path.GetFullPath(workspace).TrimEnd('\\').ToUpperInvariant());
            if (!ConvertStringSidToSid(capSidStr, out capSid)) return Win32Fail("ConvertStringSidToSid " + capSidStr);

            // Restricting SIDs: logon SID + World + cap SID (write allowlist).
            IntPtr worldSid = GetWorldSid();
            IntPtr[] restricting = new IntPtr[] { logonSid, worldSid, capSid };
            if (readOnly) restricting = new IntPtr[] { logonSid, worldSid };

            IntPtr restrictedSids = Marshal.AllocHGlobal(restricting.Length * IntPtr.Size);
            try
            {
                for (int n = 0; n < restricting.Length; n++)
                    Marshal.WriteIntPtr(restrictedSids, n * IntPtr.Size, restricting[n]);
                if (!CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE | SANDBOX_INERT | WRITE_RESTRICTED,
                        0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restricting.Length, restrictedSids, out restricted))
                    return Win32Fail("CreateRestrictedToken");
            }
            finally { Marshal.FreeHGlobal(restrictedSids); }

            if (!readOnly)
            {
                if (!GrantWorkspaceWrite(capSid, Path.GetFullPath(workspace))) return Win32Fail("GrantWorkspaceWrite");
            }
            SetDefaultDacl(restricted, capSid, !readOnly);

            // Job object: kill-on-close so children die with us.
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return Win32Fail("CreateJobObject");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            IntPtr jeliPtr = Marshal.AllocHGlobal(Marshal.SizeOf(jeli));
            try
            {
                Marshal.StructureToPtr(jeli, jeliPtr, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, jeliPtr, (uint)Marshal.SizeOf(jeli)))
                    return Win32Fail("SetInformationJobObject");
            }
            finally { Marshal.FreeHGlobal(jeliPtr); }

            // Redirected stdio pipes.
            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = (uint)Marshal.SizeOf(sa);
            sa.bInheritHandle = true;
            if (!CreatePipe(out hOutRead, out hOutWrite, IntPtr.Zero, 0) || !CreatePipe(out hErrRead, out hErrWrite, IntPtr.Zero, 0))
                return Win32Fail("CreatePipe");
            // The read ends must not be inherited by the child.
            SetHandleInformation(hOutRead, HANDLE_FLAG_INHERIT, 0);
            SetHandleInformation(hErrRead, HANDLE_FLAG_INHERIT, 0);

            STARTUPINFO si = new STARTUPINFO();
            si.cb = (uint)Marshal.SizeOf(si);
            si.dwFlags = 0x00000100 /*STARTF_USESTDHANDLES*/;
            si.hStdInput = IntPtr.Zero;
            si.hStdOutput = hOutWrite;
            si.hStdError = hErrWrite;

            StringBuilder cmd = new StringBuilder(commandLine);
            string cwd = Path.GetFullPath(workspace);
            if (!CreateProcessAsUser(restricted, null, cmd, IntPtr.Zero, IntPtr.Zero, true,
                    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi))
                return Win32Fail("CreateProcessAsUser");

            CloseHandle(hOutWrite); hOutWrite = IntPtr.Zero;
            CloseHandle(hErrWrite); hErrWrite = IntPtr.Zero;

            if (!AssignProcessToJobObject(job, pi.hProcess))
                return Win32Fail("AssignProcessToJobObject");

            // Drain output concurrently.
            string stdout = Drain(hOutRead, 4096);
            string stderr = Drain(hErrRead, 4096);

            WaitForSingleObject(pi.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode)) exitCode = 1;

            Console.Out.Write(stdout);
            if (stderr.Length > 0) Console.Error.Write(stderr);
            return (int)exitCode;
        }
        catch (Exception ex)
        {
            return Fail("unexpected error: " + ex.Message);
        }
        finally
        {
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (hOutRead != IntPtr.Zero) CloseHandle(hOutRead);
            if (hOutWrite != IntPtr.Zero) CloseHandle(hOutWrite);
            if (hErrRead != IntPtr.Zero) CloseHandle(hErrRead);
            if (hErrWrite != IntPtr.Zero) CloseHandle(hErrWrite);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (token != IntPtr.Zero) CloseHandle(token);
            if (capSid != IntPtr.Zero) Marshal.FreeHGlobal(capSid);
            if (logonSid != IntPtr.Zero) Marshal.FreeHGlobal(logonSid);
            if (_wsHandle != IntPtr.Zero && _wsHandle != new IntPtr(-1)) CloseHandle(_wsHandle);
        }
    }

    private static string BuildCommandLine(string[] args, int start)
    {
        // Quote per CommandLineToArgvW rules.
        var sb = new StringBuilder();
        for (int n = start; n < args.Length; n++)
        {
            if (n > start) sb.Append(' ');
            sb.Append(QuoteArg(args[n]));
        }
        return sb.ToString();
    }

    private static string QuoteArg(string arg)
    {
        if (arg.Length == 0) return "\"\"";
        if (arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') backslashes++;
            else if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
            }
            else { sb.Append('\\', backslashes).Append(c); backslashes = 0; }
        }
        sb.Append('\\', backslashes * 2).Append('"');
        return sb.ToString();
    }

    private static string Drain(IntPtr handle, int chunk)
    {
        var ms = new MemoryStream();
        byte[] buf = new byte[chunk];
        for (; ; )
        {
            uint read;
            if (!ReadFile(handle, buf, (uint)buf.Length, out read, IntPtr.Zero)) break;
            if (read == 0) break;
            ms.Write(buf, 0, (int)read);
            if (ms.Length > 16 * 1024 * 1024) { ms.Write(Encoding.UTF8.GetBytes("\n[output truncated at 16MB]\n"), 0, 0); break; }
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }
}
