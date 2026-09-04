'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken, ApiError, decodeTokenPayload } from '@/lib/api';
import {
  PageShell,
  Card,
  PrimaryButton,
  SecondaryButton,
  TextInput,
  Label,
  Badge,
  ErrorText,
  EmptyState,
} from '@/lib/ui';

interface CategoryRow {
  id: string;
  name: string;
}
interface ProductRow {
  id: string;
  name: string;
  price: string;
  active: boolean;
  category_id: string | null;
  image_url?: string | null;
  category_name?: string | null;
}
interface EmployeeRow {
  id: string;
  username: string;
  display_name: string;
  status: string;
  roles: string[];
}
interface RoleRow {
  id: string;
  name: string;
  permissions: string[];
}
interface CounterRow {
  id: string;
  name: string;
  code: string;
  status: 'active' | 'inactive';
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  assigned_user_username: string | null;
}
interface DeviceRow {
  id: string;
  name: string;
  type: 'counter' | 'customer_display';
  counter_id: string | null;
  status: string;
  registered_at: string;
}
interface PrinterRow {
  id: string;
  name: string;
  type: string;
  location: string | null;
  status: 'active' | 'inactive';
}
interface ResourceUsageData {
  limits: {
    max_employees: number;
    max_counters: number;
    max_customer_displays: number;
    max_printers: number;
  };
  usage: {
    active_employees: number;
    active_counters: number;
    active_displays: number;
    active_printers: number;
  };
}

type Tab =
  | 'catalog'
  | 'employees'
  | 'counters'
  | 'devices'
  | 'printers'
  | 'roles'
  | 'packing'
  | 'workflow';

const TABS: { id: Tab; label: string }[] = [
  { id: 'catalog', label: 'Products & Categories' },
  { id: 'employees', label: 'Employees' },
  { id: 'counters', label: 'Counters' },
  { id: 'devices', label: 'Devices' },
  { id: 'printers', label: 'Printers' },
  { id: 'roles', label: 'Roles & Permissions' },
  { id: 'packing', label: 'Packing Charges' },
  { id: 'workflow', label: 'Workflow' },
];

export default function ShopAdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('catalog');
  const [error, setError] = useState<string | null>(null);
  const [resourceUsage, setResourceUsage] = useState<ResourceUsageData | null>(null);

  const refreshResourceUsage = useCallback(async () => {
    try {
      const data = await api.getResourceUsage();
      setResourceUsage(data);
    } catch {
      // Non-blocking
    }
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.push('/login');
      return;
    }
    const payload = decodeTokenPayload(token);
    const perms = payload?.permissions || [];
    const hasAdminPerm =
      payload?.isSuperAdmin ||
      perms.includes('shop.settings') ||
      perms.includes('employee.manage') ||
      perms.includes('product.manage') ||
      perms.includes('*');
    if (!hasAdminPerm) {
      router.push('/counter');
    }
    refreshResourceUsage();
  }, [router, refreshResourceUsage]);

  function handleError(err: unknown) {
    setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
  }

  return (
    <PageShell title="Shop Admin" subtitle="Configure your shop, resources, and catalog." wide>
      <div className="flex gap-1 mb-6 border-b border-slate-200 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.id
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <ErrorText>{error}</ErrorText>

      {tab === 'catalog' && <CatalogTab onError={handleError} />}
      {tab === 'employees' && (
        <EmployeesTab
          onError={handleError}
          resourceUsage={resourceUsage}
          onRefreshUsage={refreshResourceUsage}
        />
      )}
      {tab === 'counters' && (
        <CountersTab
          onError={handleError}
          resourceUsage={resourceUsage}
          onRefreshUsage={refreshResourceUsage}
        />
      )}
      {tab === 'devices' && (
        <DevicesTab
          onError={handleError}
          resourceUsage={resourceUsage}
          onRefreshUsage={refreshResourceUsage}
        />
      )}
      {tab === 'printers' && (
        <PrintersTab
          onError={handleError}
          resourceUsage={resourceUsage}
          onRefreshUsage={refreshResourceUsage}
        />
      )}
      {tab === 'roles' && <RolesTab onError={handleError} />}
      {tab === 'packing' && <PackingTab onError={handleError} />}
      {tab === 'workflow' && <WorkflowTab onError={handleError} />}
    </PageShell>
  );
}

// ---- Catalog ----------------------------------------------------------------

function CatalogTab({ onError }: { onError: (e: unknown) => void }) {
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [newCatName, setNewCatName] = useState('');
  const [newProdName, setNewProdName] = useState('');
  const [newProdPrice, setNewProdPrice] = useState('');
  const [newProdCatId, setNewProdCatId] = useState<string>('');
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [cats, prods] = await Promise.all([api.listCategories(), api.listProducts()]);
      setCategories(cats);
      setProducts(prods);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addCategory() {
    if (!newCatName) return;
    try {
      await api.createCategory(newCatName);
      setNewCatName('');
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  async function addProduct() {
    if (!newProdName || !newProdPrice) return;
    try {
      const created = await api.createProduct(
        newProdName,
        Number(newProdPrice),
        newProdCatId || undefined,
      );
      if (selectedImage && created.id) {
        await api.uploadProductImage(created.id, selectedImage);
      }
      setNewProdName('');
      setNewProdPrice('');
      setNewProdCatId('');
      setSelectedImage(null);
      setImagePreview(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setSelectedImage(null);
      setImagePreview(null);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      onError(new Error('Image must not exceed 5MB'));
      return;
    }
    setSelectedImage(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleUpdateProductImage(productId: string, file: File) {
    if (file.size > 5 * 1024 * 1024) {
      onError(new Error('Image must not exceed 5MB'));
      return;
    }
    setUploadingId(productId);
    try {
      await api.uploadProductImage(productId, file);
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setUploadingId(null);
    }
  }

  async function handleRemoveProductImage(productId: string) {
    setUploadingId(productId);
    try {
      await api.deleteProductImage(productId);
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setUploadingId(null);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Add category</h3>
        <div className="flex gap-3">
          <TextInput
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            placeholder="Category name"
          />
          <SecondaryButton onClick={addCategory}>Add</SecondaryButton>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Categories</h3>
        <ul className="space-y-2">
          {categories.map((c) => (
            <li key={c.id} className="text-sm text-slate-700 py-1.5 border-b border-slate-100">
              {c.name}
            </li>
          ))}
        </ul>
        {categories.length === 0 && <EmptyState message="No categories yet." />}
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Add product</h3>
        <div className="space-y-3">
          <div>
            <Label>Product name</Label>
            <TextInput value={newProdName} onChange={(e) => setNewProdName(e.target.value)} />
          </div>
          <div>
            <Label>Price (₹)</Label>
            <TextInput
              type="number"
              value={newProdPrice}
              onChange={(e) => setNewProdPrice(e.target.value)}
            />
          </div>
          <div>
            <Label>Category</Label>
            <select
              value={newProdCatId}
              onChange={(e) => setNewProdCatId(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label>Product image (optional, max 5MB)</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleImageSelect}
              className="w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 cursor-pointer"
            />
            {imagePreview && (
              <div className="mt-2.5 flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imagePreview}
                  alt="Preview"
                  className="w-16 h-12 object-cover rounded-lg border border-slate-200"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSelectedImage(null);
                    setImagePreview(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  className="text-xs text-rose-600 hover:text-rose-800"
                >
                  Clear image
                </button>
              </div>
            )}
          </div>
          <PrimaryButton onClick={addProduct} className="w-full mt-2">
            Create product
          </PrimaryButton>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Products</h3>
        <ul className="space-y-3">
          {products.map((p) => {
            const hasImage = !!p.image_url;
            const imageUrl = hasImage ? api.getProductImageUrl(p.id) : null;
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 text-sm py-2 border-b border-slate-100"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-10 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden flex-shrink-0 flex items-center justify-center">
                    {hasImage && imageUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={imageUrl}
                        alt={p.name}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <span className="text-[10px] text-slate-400">No img</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900 truncate">{p.name}</p>
                    <p className="text-xs text-slate-500">
                      ₹{Number(p.price).toFixed(2)} · {p.category_name ?? 'No category'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <label className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 cursor-pointer transition-colors">
                    {uploadingId === p.id ? 'Uploading…' : hasImage ? 'Change' : 'Upload'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      disabled={uploadingId === p.id}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleUpdateProductImage(p.id, file);
                      }}
                    />
                  </label>
                  {hasImage && (
                    <button
                      type="button"
                      disabled={uploadingId === p.id}
                      onClick={() => handleRemoveProductImage(p.id)}
                      className="text-xs font-medium px-2 py-1 rounded text-rose-600 hover:bg-rose-50 transition-colors"
                      title="Remove product image"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {products.length === 0 && <EmptyState message="No products yet." />}
      </Card>
    </div>
  );
}

// ---- Employees ----------------------------------------------------------------

function EmployeesTab({
  onError,
  resourceUsage,
  onRefreshUsage,
}: {
  onError: (e: unknown) => void;
  resourceUsage: ResourceUsageData | null;
  onRefreshUsage: () => void;
}) {
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setEmployees(await api.listEmployees());
      setRoles(await api.listRoles());
      onRefreshUsage();
    } catch (e) {
      onError(e);
    }
  }, [onError, onRefreshUsage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeCount = resourceUsage?.usage.active_employees ?? employees.filter((e) => e.status === 'active').length;
  const maxLimit = resourceUsage?.limits.max_employees ?? 5;
  const limitReached = activeCount >= maxLimit;

  async function addEmployee() {
    if (!username || !displayName || !password) return;
    try {
      await api.createEmployee({ username, displayName, password, roleIds: selectedRoles });
      setUsername('');
      setDisplayName('');
      setPassword('');
      setSelectedRoles([]);
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
        <div>
          <h3 className="font-bold text-slate-900 text-sm">Employee Allowance</h3>
          <p className="text-xs text-slate-500">Managed per shop by Super Admin</p>
        </div>
        <Badge tone={limitReached ? 'warning' : 'neutral'}>
          Employees: {activeCount} / {maxLimit}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <h3 className="font-semibold text-slate-900 mb-4">Add employee</h3>
          {limitReached && (
            <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed">
              <strong>Employee limit reached ({activeCount}/{maxLimit}).</strong> Contact your Super Admin to increase the limit.
            </div>
          )}
          <div className="space-y-3">
            <div>
              <Label>Username</Label>
              <TextInput value={username} onChange={(e) => setUsername(e.target.value)} disabled={limitReached} />
            </div>
            <div>
              <Label>Display name</Label>
              <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} disabled={limitReached} />
            </div>
            <div>
              <Label>Temporary password</Label>
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={limitReached} />
            </div>
            <div>
              <Label>Roles</Label>
              <div className="flex flex-wrap gap-2">
                {roles.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    disabled={limitReached}
                    onClick={() =>
                      setSelectedRoles((s) =>
                        s.includes(r.id) ? s.filter((id) => id !== r.id) : [...s, r.id],
                      )
                    }
                    className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${
                      selectedRoles.includes(r.id)
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-600 border-slate-300'
                    }`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
            <PrimaryButton onClick={addEmployee} disabled={limitReached} className="w-full mt-2">
              Create employee
            </PrimaryButton>
          </div>
        </Card>

        <Card>
          <h3 className="font-semibold text-slate-900 mb-4">Employees</h3>
          <ul className="space-y-3">
            {employees.map((e) => (
              <li key={e.id} className="pb-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {e.display_name}{' '}
                    <span className="text-xs text-slate-400 font-mono">(@{e.username})</span>
                  </p>
                  <p className="text-xs text-slate-500">{(e.roles ?? []).join(', ') || 'No roles'}</p>
                </div>
                <Badge tone={e.status === 'active' ? 'success' : 'neutral'}>{e.status}</Badge>
              </li>
            ))}
          </ul>
          {employees.length === 0 && <EmptyState message="No employees yet." />}
        </Card>
      </div>
    </div>
  );
}

// ---- Counters -----------------------------------------------------------------

function CountersTab({
  onError,
  resourceUsage,
  onRefreshUsage,
}: {
  onError: (e: unknown) => void;
  resourceUsage: ResourceUsageData | null;
  onRefreshUsage: () => void;
}) {
  const router = useRouter();
  const [counters, setCounters] = useState<CounterRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [assignedUserId, setAssignedUserId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [cList, eList] = await Promise.all([api.listCounters(), api.listEmployees()]);
      setCounters(cList);
      setEmployees(eList.filter((e: EmployeeRow) => e.status === 'active'));
      onRefreshUsage();
    } catch (e) {
      onError(e);
    }
  }, [onError, onRefreshUsage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeCount = resourceUsage?.usage.active_counters ?? counters.filter((c) => c.status === 'active').length;
  const maxLimit = resourceUsage?.limits.max_counters ?? 1;
  const limitReached = activeCount >= maxLimit;

  async function addCounter() {
    if (!name || !code) return;
    try {
      await api.createCounter({
        name,
        code,
        assignedUserId: assignedUserId || null,
      });
      setName('');
      setCode('');
      setAssignedUserId('');
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  async function toggleStatus(counter: CounterRow) {
    try {
      const nextStatus = counter.status === 'active' ? 'inactive' : 'active';
      await api.updateCounter(counter.id, { status: nextStatus });
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  async function updateStaffAssignment(counterId: string, userId: string) {
    try {
      await api.updateCounter(counterId, { assignedUserId: userId || null });
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  function operateCounter(c: CounterRow) {
    window.sessionStorage.setItem('shopapp_active_counter', JSON.stringify({ id: c.id, name: c.name, code: c.code }));
    router.push('/counter');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
        <div>
          <h3 className="font-bold text-slate-900 text-sm">Counter Allowance</h3>
          <p className="text-xs text-slate-500">Physical and logical points of sale</p>
        </div>
        <Badge tone={limitReached ? 'warning' : 'neutral'}>
          Counters: {activeCount} / {maxLimit}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <h3 className="font-semibold text-slate-900 mb-4">Add Counter</h3>
          {limitReached && (
            <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed">
              <strong>Counter limit reached ({activeCount}/{maxLimit}).</strong> Contact your Super Admin to increase the limit.
            </div>
          )}
          <div className="space-y-3">
            <div>
              <Label>Counter Name</Label>
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Counter 01"
                disabled={limitReached}
              />
            </div>
            <div>
              <Label>Counter Code</Label>
              <TextInput
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="CTR-01"
                disabled={limitReached}
              />
            </div>
            <div>
              <Label>Assigned Counter Staff (optional)</Label>
              <select
                value={assignedUserId}
                onChange={(e) => setAssignedUserId(e.target.value)}
                disabled={limitReached}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
              >
                <option value="">Unassigned</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.display_name} (@{emp.username})
                  </option>
                ))}
              </select>
            </div>
            <PrimaryButton onClick={addCounter} disabled={limitReached} className="w-full mt-2">
              Create Counter
            </PrimaryButton>
          </div>
        </Card>

        <Card>
          <h3 className="font-semibold text-slate-900 mb-4">Counters</h3>
          <ul className="space-y-4">
            {counters.map((c) => (
              <li key={c.id} className="p-3.5 rounded-xl border border-slate-100 bg-slate-50/50 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-bold text-slate-900 text-sm leading-tight">{c.name}</p>
                    <p className="text-xs font-mono text-slate-500">Code: {c.code}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleStatus(c)}
                      className={`text-xs font-semibold px-2 py-1 rounded-md border ${
                        c.status === 'active'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-slate-100 text-slate-600 border-slate-200'
                      }`}
                    >
                      {c.status === 'active' ? 'Active' : 'Inactive'}
                    </button>
                    <button
                      type="button"
                      onClick={() => operateCounter(c)}
                      className="text-xs font-bold px-3 py-1 rounded-md bg-slate-900 text-white hover:bg-slate-800 transition-colors"
                    >
                      Operate
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-slate-200/60 text-xs">
                  <span className="text-slate-500">Assigned Staff:</span>
                  <select
                    value={c.assigned_user_id ?? ''}
                    onChange={(e) => updateStaffAssignment(c.id, e.target.value)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-xs bg-white"
                  >
                    <option value="">Unassigned</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
          </ul>
          {counters.length === 0 && <EmptyState message="No counters created yet." />}
        </Card>
      </div>
    </div>
  );
}

// ---- Devices ------------------------------------------------------------------

function DevicesTab({
  onError,
  resourceUsage,
  onRefreshUsage,
}: {
  onError: (e: unknown) => void;
  resourceUsage: ResourceUsageData | null;
  onRefreshUsage: () => void;
}) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [deviceName, setDeviceName] = useState('');
  const [deviceType, setDeviceType] = useState<'counter' | 'customer_display'>('customer_display');
  const [lastCredential, setLastCredential] = useState<{ name: string; credential: string } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    try {
      setDevices(await api.listDevices());
      onRefreshUsage();
    } catch (e) {
      onError(e);
    }
  }, [onError, onRefreshUsage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeDisplays = resourceUsage?.usage.active_displays ?? devices.filter((d) => d.type === 'customer_display' && d.status === 'active').length;
  const maxDisplays = resourceUsage?.limits.max_customer_displays ?? 1;
  const displayLimitReached = deviceType === 'customer_display' && activeDisplays >= maxDisplays;

  async function register() {
    if (!deviceName) return;
    try {
      const res = await api.registerDevice(deviceName, deviceType);
      setLastCredential({ name: res.device.name, credential: res.credential });
      setDeviceName('');
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
        <div>
          <h3 className="font-bold text-slate-900 text-sm">Customer Display Allowance</h3>
          <p className="text-xs text-slate-500">TV screens, tablets, and customer-facing order monitors</p>
        </div>
        <Badge tone={activeDisplays >= maxDisplays ? 'warning' : 'neutral'}>
          Displays: {activeDisplays} / {maxDisplays}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <Card>
            <h3 className="font-semibold text-slate-900 mb-1">Register a device</h3>
            <p className="text-sm text-slate-500 mb-4">
              The credential is shown once — copy it into the target screen or device immediately.
            </p>
            {displayLimitReached && (
              <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed">
                <strong>Customer Display limit reached ({activeDisplays}/{maxDisplays}).</strong> Contact your Super Admin to increase the limit.
              </div>
            )}
            <div className="space-y-3">
              <div>
                <Label>Device Type</Label>
                <select
                  value={deviceType}
                  onChange={(e) => setDeviceType(e.target.value as 'counter' | 'customer_display')}
                  className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
                >
                  <option value="customer_display">Customer Display (TV / Monitor)</option>
                  <option value="counter">Counter POS Terminal Device</option>
                </select>
              </div>
              <div>
                <Label>Device Name</Label>
                <TextInput
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder={deviceType === 'customer_display' ? 'Main TV Display' : 'POS-Terminal-1'}
                />
              </div>
              <PrimaryButton onClick={register} disabled={displayLimitReached} className="w-full mt-2">
                Register Device
              </PrimaryButton>
            </div>
          </Card>

          {lastCredential && (
            <Card className="border-amber-200 bg-amber-50">
              <p className="text-sm font-semibold text-amber-900 mb-2">
                Credential for &ldquo;{lastCredential.name}&rdquo; — shown once
              </p>
              <code className="block bg-white border border-amber-300 rounded-lg p-3 text-xs break-all font-mono">
                {lastCredential.credential}
              </code>
            </Card>
          )}
        </div>

        <Card>
          <h3 className="font-semibold text-slate-900 mb-4">Registered Devices</h3>
          <ul className="space-y-3">
            {devices.map((d) => (
              <li key={d.id} className="pb-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-900">{d.name}</p>
                  <p className="text-xs text-slate-400 capitalize">
                    {d.type === 'customer_display' ? 'Customer Display' : 'Counter Device'}
                  </p>
                </div>
                <Badge tone={d.status === 'active' ? 'success' : 'neutral'}>{d.status}</Badge>
              </li>
            ))}
          </ul>
          {devices.length === 0 && <EmptyState message="No devices registered yet." />}
        </Card>
      </div>
    </div>
  );
}

// ---- Printers -----------------------------------------------------------------

function PrintersTab({
  onError,
  resourceUsage,
  onRefreshUsage,
}: {
  onError: (e: unknown) => void;
  resourceUsage: ResourceUsageData | null;
  onRefreshUsage: () => void;
}) {
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [name, setName] = useState('');
  const [type, setType] = useState('thermal_receipt');
  const [location, setLocation] = useState('');

  const refresh = useCallback(async () => {
    try {
      setPrinters(await api.listPrinters());
      onRefreshUsage();
    } catch (e) {
      onError(e);
    }
  }, [onError, onRefreshUsage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeCount = resourceUsage?.usage.active_printers ?? printers.filter((p) => p.status === 'active').length;
  const maxLimit = resourceUsage?.limits.max_printers ?? 1;
  const limitReached = activeCount >= maxLimit;

  async function addPrinter() {
    if (!name) return;
    try {
      await api.createPrinter({ name, type, location: location || undefined });
      setName('');
      setLocation('');
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  async function toggleStatus(p: PrinterRow) {
    try {
      const nextStatus = p.status === 'active' ? 'inactive' : 'active';
      await api.updatePrinter(p.id, { status: nextStatus });
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
        <div>
          <h3 className="font-bold text-slate-900 text-sm">Printer Allowance</h3>
          <p className="text-xs text-slate-500">Thermal receipt and kitchen ticket printers</p>
        </div>
        <Badge tone={limitReached ? 'warning' : 'neutral'}>
          Printers: {activeCount} / {maxLimit}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <h3 className="font-semibold text-slate-900 mb-4">Add Printer</h3>
          {limitReached && (
            <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs leading-relaxed">
              <strong>Printer limit reached ({activeCount}/{maxLimit}).</strong> Contact your Super Admin to increase the limit.
            </div>
          )}
          <div className="space-y-3">
            <div>
              <Label>Printer Name</Label>
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Counter 01 Thermal"
                disabled={limitReached}
              />
            </div>
            <div>
              <Label>Printer Type</Label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                disabled={limitReached}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
              >
                <option value="thermal_receipt">Thermal Receipt (80mm / 58mm)</option>
                <option value="kitchen">Kitchen KOT Ticket</option>
                <option value="label">Label / Barcode</option>
              </select>
            </div>
            <div>
              <Label>Location / Purpose</Label>
              <TextInput
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Counter 01"
                disabled={limitReached}
              />
            </div>
            <PrimaryButton onClick={addPrinter} disabled={limitReached} className="w-full mt-2">
              Add Printer
            </PrimaryButton>
          </div>
        </Card>

        <Card>
          <h3 className="font-semibold text-slate-900 mb-4">Configured Printers</h3>
          <ul className="space-y-3">
            {printers.map((p) => (
              <li key={p.id} className="p-3.5 rounded-xl border border-slate-100 bg-slate-50/50 flex items-center justify-between">
                <div>
                  <p className="font-bold text-slate-900 text-sm leading-tight">{p.name}</p>
                  <p className="text-xs text-slate-500 capitalize">
                    {p.type.replace('_', ' ')} {p.location ? `· ${p.location}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggleStatus(p)}
                  className={`text-xs font-semibold px-2.5 py-1 rounded-md border ${
                    p.status === 'active'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  {p.status === 'active' ? 'Active' : 'Inactive'}
                </button>
              </li>
            ))}
          </ul>
          {printers.length === 0 && <EmptyState message="No printers configured yet." />}
        </Card>
      </div>
    </div>
  );
}

// ---- Roles --------------------------------------------------------------------

function RolesTab({ onError }: { onError: (e: unknown) => void }) {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<string[]>([]);
  const [roleName, setRoleName] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [rList, catalog] = await Promise.all([api.listRoles(), api.permissionCatalog()]);
      setRoles(rList);
      setPermissionCatalog(catalog);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addRole() {
    if (!roleName) return;
    try {
      await api.createRole(roleName, selectedPermissions);
      setRoleName('');
      setSelectedPermissions([]);
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Create role</h3>
        <Label>Role name</Label>
        <TextInput value={roleName} onChange={(e) => setRoleName(e.target.value)} className="mb-4" />
        <Label>Permissions</Label>
        <div className="flex flex-wrap gap-2 mb-4">
          {permissionCatalog.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() =>
                setSelectedPermissions((s) =>
                  s.includes(code) ? s.filter((c) => c !== code) : [...s, code],
                )
              }
              className={`text-xs font-mono px-2.5 py-1 rounded-lg border ${
                selectedPermissions.includes(code)
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-300'
              }`}
            >
              {code}
            </button>
          ))}
        </div>
        <PrimaryButton onClick={addRole} className="w-full">
          Create role
        </PrimaryButton>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Roles</h3>
        <ul className="space-y-3">
          {roles.map((r) => (
            <li key={r.id} className="pb-3 border-b border-slate-100">
              <p className="text-sm font-medium text-slate-900 mb-1">{r.name}</p>
              <div className="flex flex-wrap gap-1">
                {(r.permissions ?? []).map((p: string) => (
                  <span key={p} className="text-xs font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                    {p}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
        {roles.length === 0 && <EmptyState message="No roles yet." />}
      </Card>
    </div>
  );
}

// ---- Packing ------------------------------------------------------------------

function PackingTab({ onError }: { onError: (e: unknown) => void }) {
  const [rule, setRule] = useState('none');
  const [flatCharge, setFlatCharge] = useState('0');
  const [perItemCharge, setPerItemCharge] = useState('0');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getPackingConfig()
      .then((c) => {
        setRule(c.rule ?? 'none');
        setFlatCharge(String(c.flatCharge ?? 0));
        setPerItemCharge(String(c.perItemCharge ?? 0));
      })
      .catch(onError);
  }, [onError]);

  async function save() {
    try {
      await api.setPackingConfig({
        rule,
        flatCharge: Number(flatCharge),
        perItemCharge: Number(perItemCharge),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <Card className="max-w-md">
      <h3 className="font-semibold text-slate-900 mb-4">Packing charges</h3>
      <Label>Packing rule</Label>
      <select
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        className="w-full mb-4 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
      >
        <option value="none">No packing charge</option>
        <option value="flat">Flat charge per order</option>
        <option value="per_item">Per-item charge</option>
      </select>
      {rule === 'flat' && (
        <div className="mb-4">
          <Label>Flat charge (₹)</Label>
          <TextInput
            type="number"
            value={flatCharge}
            onChange={(e) => setFlatCharge(e.target.value)}
          />
        </div>
      )}
      {rule === 'per_item' && (
        <div className="mb-4">
          <Label>Charge per item (₹)</Label>
          <TextInput
            type="number"
            value={perItemCharge}
            onChange={(e) => setPerItemCharge(e.target.value)}
          />
        </div>
      )}
      <PrimaryButton onClick={save} className="w-full">
        {saved ? 'Saved ✓' : 'Save'}
      </PrimaryButton>
    </Card>
  );
}

// ---- Workflow -----------------------------------------------------------------

const MODULES = ['kitchen_display', 'tv', 'coordinator_display', 'printer'];

function WorkflowTab({ onError }: { onError: (e: unknown) => void }) {
  const [mode, setMode] = useState('direct');
  const [enabledModules, setEnabledModules] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .getWorkflowConfig()
      .then((c) => {
        setMode(c.mode ?? 'direct');
        setEnabledModules(c.enabledModules ?? []);
      })
      .catch(onError);
  }, [onError]);

  async function save() {
    try {
      await api.setWorkflowConfig({ mode, enabledModules });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <Card className="max-w-md">
      <h3 className="font-semibold text-slate-900 mb-4">Order workflow</h3>
      <Label>Mode</Label>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        className="w-full mb-4 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
      >
        <option value="direct">Direct (Counter → Customer)</option>
        <option value="coordinator">Coordinator (Counter → Coordinator → Customer)</option>
        <option value="kitchen">Kitchen (Counter → Kitchen → Ready → Customer)</option>
      </select>
      <Label>Enabled modules</Label>
      <div className="flex flex-wrap gap-2 mb-4">
        {MODULES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() =>
              setEnabledModules((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]))
            }
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${
              enabledModules.includes(m)
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-300'
            }`}
          >
            {m.replace('_', ' ')}
          </button>
        ))}
      </div>
      <PrimaryButton onClick={save} className="w-full">
        {saved ? 'Saved ✓' : 'Save'}
      </PrimaryButton>
    </Card>
  );
}
