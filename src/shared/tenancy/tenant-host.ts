import type { FastifyRequest } from 'fastify';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const RESERVED_TENANT_LABELS = new Set(['www', 'admin']);
const SUBDOMAIN_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

const normalizeHostname = (hostname: string): string =>
  hostname.trim().toLowerCase().replace(/\.$/, '');

const stripPort = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']');
    return closingBracket > 0 ? trimmed.slice(1, closingBracket) : trimmed;
  }
  return trimmed.split(':')[0] ?? '';
};

const isReservedOrInvalid = (subdomain: string): boolean =>
  !SUBDOMAIN_REGEX.test(subdomain) || RESERVED_TENANT_LABELS.has(subdomain);

export type TenantHostMapping = {
  hostname: string;
  target: string;
  targetType: 'schema' | 'subdomain';
};

const parseHostMappings = (value: string | undefined): TenantHostMapping[] =>
  splitList(value)
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex < 1) {
        return null;
      }

      const hostname = normalizeHostname(entry.slice(0, separatorIndex));
      const rawTarget = entry.slice(separatorIndex + 1).trim().toLowerCase();
      const [prefix, prefixedTarget] = rawTarget.includes(':')
        ? (rawTarget.split(':', 2) as [string, string])
        : ['', rawTarget];
      const target = prefixedTarget.trim();
      if (!hostname || !target) {
        return null;
      }

      const targetType =
        prefix === 'schema' || target.includes('_') ? 'schema' : 'subdomain';
      return { hostname, target, targetType };
    })
    .filter((mapping): mapping is TenantHostMapping => mapping !== null);

export const extractHostname = (request: FastifyRequest): string | null => {
  const forwardedHost = request.headers['x-forwarded-host'];
  const rawHost =
    typeof forwardedHost === 'string' && forwardedHost.trim().length > 0
      ? forwardedHost.split(',')[0]
      : typeof request.headers.host === 'string'
        ? request.headers.host
        : '';

  const hostname = stripPort(rawHost ?? '');
  return hostname.length > 0 ? normalizeHostname(hostname) : null;
};

export type TenantHostConfig = {
  baseDomains: string[];
  environmentPrefixes: string[];
  hostMappings: TenantHostMapping[];
};

export const getTenantHostConfig = (): TenantHostConfig => ({
  baseDomains: splitList(process.env.TENANT_BASE_DOMAINS ?? process.env.APP_BASE_DOMAIN),
  environmentPrefixes: splitList(process.env.TENANT_ENV_PREFIXES ?? 'dev,staging,preprod'),
  hostMappings: parseHostMappings(process.env.TENANT_HOST_MAPPINGS),
});

export type TenantHostResolution = {
  value: string;
  type: 'schema' | 'subdomain';
};

export const resolveTenantFromHostname = (
  hostname: string,
  config: TenantHostConfig = getTenantHostConfig()
): TenantHostResolution | null => {
  const normalizedHostname = normalizeHostname(hostname);
  if (LOCAL_HOSTS.has(normalizedHostname)) {
    return null;
  }

  const mappedTenant = config.hostMappings.find((mapping) => mapping.hostname === normalizedHostname);
  if (mappedTenant) {
    return { value: mappedTenant.target, type: mappedTenant.targetType };
  }

  const labels = normalizedHostname.split('.').filter(Boolean);
  if (labels.length < 3) {
    return null;
  }

  const matchedBaseDomain = config.baseDomains
    .map(normalizeHostname)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((baseDomain) => normalizedHostname === baseDomain || normalizedHostname.endsWith(`.${baseDomain}`));

  if (matchedBaseDomain) {
    const baseLabelCount = matchedBaseDomain.split('.').filter(Boolean).length;
    const tenantLabels = labels.slice(0, labels.length - baseLabelCount);
    const effectiveLabels =
      tenantLabels.length > 1 && config.environmentPrefixes.includes(tenantLabels[0] ?? '')
        ? tenantLabels.slice(1)
        : tenantLabels;
    const candidate = effectiveLabels[0] ?? '';
    return candidate && !isReservedOrInvalid(candidate)
      ? { value: candidate, type: 'subdomain' }
      : null;
  }

  const firstLabel = labels[0] ?? '';
  return firstLabel && !isReservedOrInvalid(firstLabel)
    ? { value: firstLabel, type: 'subdomain' }
    : null;
};

export const resolveTenantSubdomainFromHostname = (
  hostname: string,
  config: TenantHostConfig = getTenantHostConfig()
): string | null => {
  const resolution = resolveTenantFromHostname(hostname, config);
  return resolution?.type === 'subdomain' ? resolution.value : null;
};
