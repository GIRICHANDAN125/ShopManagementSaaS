'use client';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const TOKEN_KEY = 'shopapp_access_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

export interface TokenPayload {
  sub: string;
  tenantId: string | null;
  isSuperAdmin: boolean;
  permissions: string[];
}

export class ApiError extends Error {
  status: number;
  body: { message?: string | string[]; error?: string; statusCode?: number };
  constructor(message: string, status: number, body: ApiError['body']) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Decodes a JWT payload WITHOUT verifying the signature — for display
 * purposes only (e.g. "logged in as X"). All real authorization decisions
 * happen server-side; the frontend never trusts this for access control. */
export function decodeTokenPayload(token: string): TokenPayload | null {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

async function request(path: string, options: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      Array.isArray(body.message) ? body.message.join(', ') : body.message ?? `Request failed (${res.status})`,
      res.status,
      body,
    );
  }
  return body;
}

export const api = {
  tenantLogin: (shopCode: string, username: string, password: string) =>
    request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ shopCode, username, password }),
    }) as Promise<AuthTokens>,

  superAdminLogin: (username: string, password: string) =>
    request('/auth/super-admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }) as Promise<AuthTokens>,

  createOrder: (payload: {
    idempotencyKey: string;
    items: { productId: string; quantity: number }[];
    orderType: string;
    packingRule?: string;
    flatPackingCharge?: number;
    perItemPackingCharge?: number;
  }) => request('/orders', { method: 'POST', body: JSON.stringify(payload) }),

  cancelOrder: (id: string) => request(`/orders/${id}/cancel`, { method: 'POST' }),
  reprintOrder: (id: string) => request(`/orders/${id}/reprint`, { method: 'POST' }),
  listActiveOrders: () => request('/orders/active'),
  updateOrderStatus: (id: string, status: string) =>
    request(`/orders/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  listDevices: () => request('/devices'),
  registerDevice: (name: string, type: 'counter' | 'customer_display' = 'counter', counterId?: string) =>
    request('/devices', { method: 'POST', body: JSON.stringify({ name, type, counterId }) }),

  reserveRange: (deviceId: string, blockSize: number) =>
    request(`/devices/${deviceId}/reserve-range`, {
      method: 'POST',
      body: JSON.stringify({ blockSize }),
    }),

  deviceConnect: (deviceId: string, credential: string) =>
    request('/devices/connect', { method: 'POST', body: JSON.stringify({ deviceId, credential }) }),

  syncOfflineOrder: (payload: {
    idempotencyKey: string;
    items: { productId: string; quantity: number }[];
    orderType: string;
    deviceId: string;
    reservedOrderNumber: number;
    createdAtDevice: string;
  }) => request('/orders/sync-offline', { method: 'POST', body: JSON.stringify(payload) }),

  listCategories: () => request('/catalog/categories'),
  createCategory: (name: string) =>
    request('/catalog/categories', { method: 'POST', body: JSON.stringify({ name }) }),
  listProducts: () => request('/catalog/products'),
  createProduct: (name: string, price: number, categoryId?: string) =>
    request('/catalog/products', {
      method: 'POST',
      body: JSON.stringify({ name, price, categoryId }),
    }),
  updateProduct: (id: string, patch: Record<string, unknown>) =>
    request(`/catalog/products/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  uploadProductImage: async (productId: string, file: File) => {
    const formData = new FormData();
    formData.append('image', file);
    const token = getToken();
    const res = await fetch(`${API_BASE}/catalog/products/${productId}/image`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        Array.isArray(body.message) ? body.message.join(', ') : body.message ?? `Upload failed (${res.status})`,
        res.status,
        body,
      );
    }
    return body;
  },
  deleteProductImage: (productId: string) =>
    request(`/catalog/products/${productId}/image`, { method: 'DELETE' }),
  getProductImageUrl: (productId: string) => {
    const token = getToken();
    return `${API_BASE}/catalog/products/${productId}/image${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  },

  listEmployees: () => request('/employees'),
  createEmployee: (payload: {
    username: string;
    displayName: string;
    password: string;
    roleIds: string[];
  }) => request('/employees', { method: 'POST', body: JSON.stringify(payload) }),
  disableEmployee: (id: string) => request(`/employees/${id}/disable`, { method: 'POST' }),

  listRoles: () => request('/roles'),
  permissionCatalog: () => request('/roles/permission-catalog'),
  createRole: (name: string, permissionCodes: string[]) =>
    request('/roles', { method: 'POST', body: JSON.stringify({ name, permissionCodes }) }),

  getPackingConfig: () => request('/settings/packing'),
  setPackingConfig: (payload: { rule: string; flatCharge?: number; perItemCharge?: number }) =>
    request('/settings/packing', { method: 'POST', body: JSON.stringify(payload) }),
  getWorkflowConfig: () => request('/settings/workflow'),
  setWorkflowConfig: (payload: { mode: string; enabledModules: string[] }) =>
    request('/settings/workflow', { method: 'POST', body: JSON.stringify(payload) }),
  getResourceUsage: () => request('/settings/resource-usage'),

  listCounters: () => request('/counters'),
  getAssignedCounter: () => request('/counters/assigned-to-me'),
  createCounter: (payload: { name: string; code: string; assignedUserId?: string | null }) =>
    request('/counters', { method: 'POST', body: JSON.stringify(payload) }),
  updateCounter: (
    id: string,
    payload: { name?: string; code?: string; status?: 'active' | 'inactive'; assignedUserId?: string | null },
  ) => request(`/counters/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteCounter: (id: string) => request(`/counters/${id}`, { method: 'DELETE' }),

  listPrinters: () => request('/printers'),
  createPrinter: (payload: { name: string; type?: string; location?: string }) =>
    request('/printers', { method: 'POST', body: JSON.stringify(payload) }),
  updatePrinter: (
    id: string,
    payload: { name?: string; type?: string; location?: string; status?: 'active' | 'inactive' },
  ) => request(`/printers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePrinter: (id: string) => request(`/printers/${id}`, { method: 'DELETE' }),

  reportsToday: () => request('/reports/today'),
  reportsPreviousDay: () => request('/reports/previous-day'),
  reportsWeekly: () => request('/reports/weekly'),
  reportsMonthly: () => request('/reports/monthly'),

  listTenants: () => request('/super-admin/tenants'),
  createTenant: (
    input:
      | string
      | {
          displayName: string;
          businessType?: string;
          adminUsername?: string;
          adminDisplayName?: string;
          adminPassword?: string;
          maxEmployees?: number;
          maxCounters?: number;
          maxCustomerDisplays?: number;
          maxPrinters?: number;
        },
    businessType?: string,
  ) => {
    const payload = typeof input === 'string' ? { displayName: input, businessType } : input;
    return request('/super-admin/tenants', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  setTenantStatus: (tenantId: string, status: 'active' | 'inactive') =>
    request('/super-admin/tenants/status', {
      method: 'POST',
      body: JSON.stringify({ tenantId, status }),
    }),
  updateTenantLimits: (
    tenantId: string,
    limits: { maxEmployees: number; maxCounters: number; maxCustomerDisplays: number; maxPrinters: number },
  ) =>
    request(`/super-admin/tenants/${tenantId}/limits`, {
      method: 'PUT',
      body: JSON.stringify(limits),
    }),
};
