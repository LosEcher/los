// los-probe-runner.cs — hash-pinned read-only probe supervisor (Windows).
//
// The los replacement for a general sandboxed shell on Windows executor
// nodes: instead of arbitrary commands under a restricted token (blocked at
// the mechanism level in the los service-session environment — see
// los-windows-sandbox.cs STATUS v4), this runner executes ONLY probe scripts
// whose SHA-256 matches a pin. The probe scripts are read-only by
// construction; the pin prevents tampered or arbitrary scripts from running
// (fail-closed). Process tree is confined to a kill-on-close Job Object with
// timeout and output capture.
//
// Pin sources (merged, later wins):
//   1. --pins <json-file>: {"<path>": "<sha256-hex>", ...} (deploy-managed)
//   2. embedded default pins (compiled in, see DefaultPins)
// A script whose path is not pinned at all, or whose hash does not match, is
// refused with exit code 3.
//
// Build (csc ships with .NET Framework on every Win10+):
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo
//     /platform:anycpu /target:exe /out:los-probe-runner.exe los-probe-runner.cs
//
// Usage:
//   los-probe-runner.exe --script <path> [--timeout-ms <n>] [--pins <json>] [-- <args...>]
//
// Output: a JSON envelope on stdout:
//   {"ok":bool,"pinned":bool,"script":"...","sha256":"...","exit_code":n,
//    "ms":n,"output":"<child stdout+stderr>"}
// On pin/refusal errors the envelope has ok=false and an error field (exit 3).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class ProbeRunner
{
    // ── Embedded default pins (script path → sha256 hex, lowercase) ──────
    // Update by running:
    //   certutil -hashfile los-probe-net.ps1 SHA256
    private static readonly Dictionary<string, string> DefaultPins = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { @"C:\los\bin\probe\los-probe-net.ps1", "8feb80b3fe891716d65b5eacf0a6e1d7bda6faf53f8f1b3dcdda1ae510db37b5" },
    };

    // ── Win32 constants ──────────────────────────────────────────────────
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x1;
    private const long OUTPUT_CAP = 16L * 1024 * 1024;
    private const int EXIT_PIN_DENIED = 3;
    private const int EXIT_TIMEOUT = 124;

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
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attr, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attr, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr h, byte[] buf, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    private static int Fail(string message)
    {
        Console.WriteLine("{\"ok\":false,\"error\":" + JsonEsc(message) + "}");
        return 1;
    }

    private static string JsonEsc(string s)
    {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("X4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }

    private static string Sha256Hex(string path)
    {
        using (var sha = SHA256.Create())
        using (var fs = File.OpenRead(path))
        {
            byte[] digest = sha.ComputeHash(fs);
            StringBuilder sb = new StringBuilder(digest.Length * 2);
            foreach (byte b in digest) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }
    }

    private static Dictionary<string, string> LoadPins(string pinsFile)
    {
        var pins = new Dictionary<string, string>(DefaultPins, StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(pinsFile) || !File.Exists(pinsFile)) return pins;
        try
        {
            string json = File.ReadAllText(pinsFile);
            // minimal {"path": "hex"} parser — a real JSON parser is not
            // available without dependencies; the format is generated by the
            // deploy tooling and validated at build time.
            int i = 0;
            while (i < json.Length)
            {
                int q1 = json.IndexOf('"', i);
                if (q1 < 0) break;
                int q2 = json.IndexOf('"', q1 + 1);
                if (q2 < 0) break;
                string key = json.Substring(q1 + 1, q2 - q1 - 1);
                int colon = json.IndexOf(':', q2 + 1);
                if (colon < 0) break;
                int q3 = json.IndexOf('"', colon + 1);
                if (q3 < 0) break;
                int q4 = json.IndexOf('"', q3 + 1);
                if (q4 < 0) break;
                string value = json.Substring(q3 + 1, q4 - q3 - 1);
                pins[key] = value.ToLowerInvariant();
                i = q4 + 1;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("{\"ok\":false,\"error\":" + JsonEsc("pins file unreadable: " + ex.Message) + "}");
            Environment.Exit(EXIT_PIN_DENIED);
        }
        return pins;
    }

    private static string DrainReader(IntPtr handle, int timeoutMs, StringBuilder sink)
    {
        byte[] buf = new byte[8192];
        uint read;
        long total = 0;
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            if (!ReadFile(handle, buf, (uint)buf.Length, out read, IntPtr.Zero)) break;
            if (read == 0) break;
            total += read;
            if (total > OUTPUT_CAP) { sink.Append("…[output truncated]"); break; }
            sink.Append(Encoding.UTF8.GetString(buf, 0, (int)read));
            if (stopwatch.ElapsedMilliseconds > timeoutMs + 5000) { sink.Append("…[drain timeout]"); break; }
        }
        return sink.ToString();
    }

    private static void Main(string[] args)
    {
        string script = null, pinsFile = null;
        int timeoutMs = 30000;
        var probeArgs = new List<string>();
        int i = 0;
        bool afterDash = false;
        for (; i < args.Length; i++)
        {
            string a = args[i];
            if (afterDash) { probeArgs.Add(a); continue; }
            if (a == "--") { afterDash = true; continue; }
            if (a == "--script" && i + 1 < args.Length) { script = args[++i]; continue; }
            if (a == "--pins" && i + 1 < args.Length) { pinsFile = args[++i]; continue; }
            if (a == "--timeout-ms" && i + 1 < args.Length) { int.TryParse(args[++i], out timeoutMs); continue; }
        }

        if (string.IsNullOrEmpty(script))
            { Environment.Exit(Fail("missing --script <path>")); return; }
        if (timeoutMs < 1000) timeoutMs = 1000;
        if (timeoutMs > 120000) timeoutMs = 120000;

        string fullScript = Path.GetFullPath(script);
        if (!File.Exists(fullScript))
            { Environment.Exit(Fail("script not found: " + fullScript)); return; }

        var pins = LoadPins(pinsFile);
        string pinned;
        if (!pins.TryGetValue(fullScript, out pinned) && !pins.TryGetValue(script, out pinned))
        {
            Console.WriteLine("{\"ok\":false,\"error\":" + JsonEsc("unpinned script (fail-closed): " + script) + "}");
            Environment.Exit(EXIT_PIN_DENIED);
            return;
        }

        string actual = Sha256Hex(fullScript);
        if (!string.Equals(actual, pinned, StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine("{\"ok\":false,\"pinned\":true,\"script\":" + JsonEsc(script)
                + ",\"sha256\":" + JsonEsc(actual)
                + ",\"error\":" + JsonEsc("pinned script mismatch (fail-closed), expected " + pinned) + "}");
            Environment.Exit(EXIT_PIN_DENIED);
            return;
        }

        // ── Spawn powershell under a kill-on-close Job Object ─────────────
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { Environment.Exit(Fail("CreateJobObject 0x" + Marshal.GetLastWin32Error().ToString("X8"))); return; }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        IntPtr jeliPtr = Marshal.AllocHGlobal(Marshal.SizeOf(jeli));
        try
        {
            Marshal.StructureToPtr(jeli, jeliPtr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, jeliPtr, (uint)Marshal.SizeOf(jeli)))
            { Environment.Exit(Fail("SetInformationJobObject 0x" + Marshal.GetLastWin32Error().ToString("X8"))); return; }
        }
        finally { Marshal.FreeHGlobal(jeliPtr); }

        // Pipes: child-side write ends inheritable, parent-side read ends not.
        IntPtr hOutRead, hOutWrite, hErrRead, hErrWrite;
        if (!CreatePipe(out hOutRead, out hOutWrite, IntPtr.Zero, 0)
            || !CreatePipe(out hErrRead, out hErrWrite, IntPtr.Zero, 0))
        { Environment.Exit(Fail("CreatePipe 0x" + Marshal.GetLastWin32Error().ToString("X8"))); return; }
        SetHandleInformation(hOutRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(hErrRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(hOutWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(hErrWrite, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        STARTUPINFO si = new STARTUPINFO();
        si.cb = (uint)Marshal.SizeOf(si);
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = IntPtr.Zero;
        si.hStdOutput = hOutWrite;
        si.hStdError = hErrWrite;

        string dir = Path.GetDirectoryName(fullScript);
        StringBuilder psCmd = new StringBuilder(1024);
        psCmd.Append("\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File ");
        psCmd.Append('"').Append(fullScript).Append('"');
        foreach (string pa in probeArgs) psCmd.Append(' ').Append('"').Append(pa.Replace("\"", "\\\"")).Append('"');

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        if (!CreateProcess(null, psCmd, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, IntPtr.Zero, dir, ref si, out pi))
        { Environment.Exit(Fail("CreateProcess 0x" + Marshal.GetLastWin32Error().ToString("X8"))); return; }

        AssignProcessToJobObject(job, pi.hProcess);
        CloseHandle(hOutWrite); hOutWrite = IntPtr.Zero;
        CloseHandle(hErrWrite); hErrWrite = IntPtr.Zero;

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var tOut = new Thread(() => DrainReader(hOutRead, timeoutMs, stdout)) { IsBackground = true };
        var tErr = new Thread(() => DrainReader(hErrRead, timeoutMs, stderr)) { IsBackground = true };
        tOut.Start(); tErr.Start();

        uint waitResult = WaitForSingleObject(pi.hProcess, (uint)timeoutMs);
        bool timedOut = waitResult != 0; // WAIT_OBJECT_0=0, WAIT_TIMEOUT=0x102
        if (timedOut)
        {
            try { TerminateProcess(pi.hProcess, 1); } catch { }
            CloseHandle(job); job = IntPtr.Zero; // KILL_ON_JOB_CLOSE → tree dies
        }
        else
        {
            tOut.Join(5000); tErr.Join(5000);
        }
        uint exitCode = 0;
        GetExitCodeProcess(pi.hProcess, out exitCode);
        long ms = stopwatch.ElapsedMilliseconds;

        string output = (stdout.Length > 0 ? stdout.ToString() : "") + (stderr.Length > 0 ? stderr.ToString() : "");
        if (timedOut)
        {
            Console.WriteLine("{\"ok\":false,\"pinned\":true,\"script\":" + JsonEsc(script)
                + ",\"sha256\":" + JsonEsc(actual)
                + ",\"exit_code\":124,\"ms\":" + ms
                + ",\"error\":" + JsonEsc("probe timed out after " + timeoutMs + "ms")
                + ",\"output\":" + JsonEsc(output) + "}");
            Environment.Exit(EXIT_TIMEOUT);
        }

        Console.WriteLine("{\"ok\":" + (exitCode == 0 ? "true" : "false")
            + ",\"pinned\":true,\"script\":" + JsonEsc(script)
            + ",\"sha256\":" + JsonEsc(actual)
            + ",\"exit_code\":" + exitCode
            + ",\"ms\":" + ms
            + ",\"output\":" + JsonEsc(output) + "}");

        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        CloseHandle(hOutRead); CloseHandle(hErrRead);
        if (job != IntPtr.Zero) CloseHandle(job);
        Environment.Exit((int)exitCode);
    }
}
