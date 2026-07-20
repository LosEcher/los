import { ProxyAgent, setGlobalDispatcher } from 'undici';

type ProxyEnvironment = Partial<Pick<NodeJS.ProcessEnv, 'HTTPS_PROXY' | 'HTTP_PROXY'>>;

type ProxyRuntime = {
  createAgent(uri: string): unknown;
  setDispatcher(dispatcher: unknown): void;
};

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function _createProxyAwareFetch(
  runtime: ProxyRuntime,
  fetchImplementation: FetchImplementation,
): (input: string | URL | Request, init?: RequestInit, env?: ProxyEnvironment) => Promise<Response> {
  let configuredProxy: string | undefined;

  return async (input, init, env = process.env) => {
    const proxy = env.HTTPS_PROXY?.trim() || env.HTTP_PROXY?.trim();
    if (proxy && proxy !== configuredProxy) {
      runtime.setDispatcher(runtime.createAgent(proxy));
      configuredProxy = proxy;
    }
    return fetchImplementation(input, init);
  };
}

const proxyAwareFetch = _createProxyAwareFetch(
  {
    createAgent: uri => new ProxyAgent({ uri }),
    setDispatcher: dispatcher => setGlobalDispatcher(dispatcher as ProxyAgent),
  },
  globalThis.fetch,
);

export function fetchWithConfiguredProxy(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return proxyAwareFetch(input, init);
}
