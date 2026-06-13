import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getJson, type ProviderDiscovery, type ProviderModelsResponse } from '../api';
import { buildProviderOptions, providerRoutesFromModels } from '../chat-helpers';

export function useChatProviders() {
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');

  const onboarding = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => getJson<ProviderDiscovery>('/onboarding'),
    staleTime: 20_000,
  });

  const modelRoutes = useQuery({
    queryKey: ['provider-models', provider || 'default'],
    queryFn: () => getJson<ProviderModelsResponse>(
      provider ? `/providers/models?provider=${encodeURIComponent(provider)}` : '/providers/models',
    ),
    staleTime: 20_000,
  });

  const providerOptions = useMemo(() => {
    return buildProviderOptions(onboarding.data, modelRoutes.data);
  }, [onboarding.data, modelRoutes.data]);

  const providerRoutes = useMemo(() => providerRoutesFromModels(modelRoutes.data), [modelRoutes.data]);

  const selectedRoute = useMemo(() => {
    return providerRoutes.find(route => route.provider === provider) ?? providerRoutes[0] ?? null;
  }, [providerRoutes, provider]);

  const modelOptions = useMemo(() => {
    const ids = new Set<string>();
    if (selectedRoute?.model) ids.add(selectedRoute.model);
    for (const item of selectedRoute?.models ?? []) {
      if (item.id) ids.add(item.id);
    }
    return [...ids];
  }, [selectedRoute]);

  // Auto-select first provider
  useEffect(() => {
    if (provider || providerOptions.length === 0) return;
    if (!modelRoutes.data && !modelRoutes.isError) return;
    setProvider(providerOptions[0]!.id);
  }, [modelRoutes.data, modelRoutes.isError, provider, providerOptions]);

  // Auto-select fallback model
  useEffect(() => {
    if (!selectedRoute) return;
    const fallback = selectedRoute.model ?? modelOptions[0] ?? '';
    if (!fallback) return;
    if (!model || (modelOptions.length > 0 && !modelOptions.includes(model))) {
      setModel(fallback);
    }
  }, [model, modelOptions, selectedRoute]);

  return {
    provider, setProvider,
    model, setModel,
    onboarding,
    modelRoutes,
    providerOptions,
    providerRoutes,
    selectedRoute,
    modelOptions,
  };
}
