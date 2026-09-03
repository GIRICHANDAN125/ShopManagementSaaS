'use client';
import { useEffect, useState, useCallback } from 'react';
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

type Tab = 'catalog' | 'employees' | 'roles' | 'packing' | 'workflow' | 'devices';

const TABS: { id: Tab; label: string }[] = [
  { id: 'catalog', label: 'Products & Categories' },
  { id: 'employees', label: 'Employees' },
  { id: 'roles', label: 'Roles & Permissions' },
  { id: 'packing', label: 'Packing Charges' },
  { id: 'workflow', label: 'Workflow' },
  { id: 'devices', label: 'Devices' },
];

export default function ShopAdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('catalog');
  const [error, setError] = useState<string | null>(null);

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
  }, [router]);

  function handleError(err: unknown) {
    setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
  }

  return (
    <PageShell title="Shop Admin" subtitle="Configure your shop." wide>
      <div className="flex gap-1 mb-6 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
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
      {tab === 'employees' && <EmployeesTab onError={handleError} />}
      {tab === 'roles' && <RolesTab onError={handleError} />}
      {tab === 'packing' && <PackingTab onError={handleError} />}
      {tab === 'workflow' && <WorkflowTab onError={handleError} />}
      {tab === 'devices' && <DevicesTab onError={handleError} />}
    </PageShell>
  );
}

// ---- Catalog ----------------------------------------------------------------

function CatalogTab({ onError }: { onError: (e: unknown) => void }) {
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [categoryName, setCategoryName] = useState('');
  const [productName, setProductName] = useState('');
  const [productPrice, setProductPrice] = useState('');
  const [productCategory, setProductCategory] = useState('');

  const refresh = useCallback(async () => {
    try {
      setCategories(await api.listCategories());
      setProducts(await api.listProducts());
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addCategory() {
    if (!categoryName) return;
    try {
      await api.createCategory(categoryName);
      setCategoryName('');
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  async function addProduct() {
    if (!productName || !productPrice) return;
    try {
      await api.createProduct(productName, Number(productPrice), productCategory || undefined);
      setProductName('');
      setProductPrice('');
      refresh();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Categories</h3>
        <div className="flex gap-2 mb-4">
          <TextInput
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            placeholder="e.g. Beverages"
          />
          <SecondaryButton onClick={addCategory}>Add</SecondaryButton>
        </div>
        <ul className="space-y-1">
          {categories.map((c) => (
            <li key={c.id} className="text-sm text-slate-700 py-1.5 border-b border-slate-100">
              {c.name}
            </li>
          ))}
        </ul>
        {categories.length === 0 && <EmptyState message="No categories yet." />}
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Products</h3>
        <div className="space-y-2 mb-4">
          <TextInput
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            placeholder="Product name"
          />
          <div className="flex gap-2">
            <TextInput
              type="number"
              value={productPrice}
              onChange={(e) => setProductPrice(e.target.value)}
              placeholder="Price"
            />
            <select
              value={productCategory}
              onChange={(e) => setProductCategory(e.target.value)}
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
          <SecondaryButton onClick={addProduct} className="w-full">
            Add product
          </SecondaryButton>
        </div>
        <ul className="space-y-1 max-h-64 overflow-y-auto">
          {products.map((p) => (
            <li
              key={p.id}
              className="text-sm text-slate-700 py-1.5 border-b border-slate-100 flex justify-between"
            >
              <span>{p.name}</span>
              <span className="text-slate-400">₹{p.price}</span>
            </li>
          ))}
        </ul>
        {products.length === 0 && <EmptyState message="No products yet." />}
      </Card>
    </div>
  );
}

// ---- Employees ----------------------------------------------------------------

function EmployeesTab({ onError }: { onError: (e: unknown) => void }) {
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
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Add employee</h3>
        <div className="space-y-3">
          <div>
            <Label>Username</Label>
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <Label>Display name</Label>
            <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label>Temporary password</Label>
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <Label>Roles</Label>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
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
          <PrimaryButton onClick={addEmployee} className="w-full">
            Add employee
          </PrimaryButton>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold text-slate-900 mb-4">Employees</h3>
        <ul className="space-y-2">
          {employees.map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2 border-b border-slate-100">
              <div>
                <p className="text-sm font-medium text-slate-900">{e.display_name}</p>
                <p className="text-xs text-slate-400">{e.username} · {(e.roles ?? []).join(', ') || 'no role'}</p>
              </div>
              <Badge tone={e.status === 'active' ? 'success' : 'neutral'}>{e.status}</Badge>
            </li>
          ))}
        </ul>
        {employees.length === 0 && <EmptyState message="No employees yet." />}
      </Card>
    </div>
  );
}

// ---- Roles ----------------------------------------------------------------

function RolesTab({ onError }: { onError: (e: unknown) => void }) {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setRoles(await api.listRoles());
      setPermissionCatalog(await api.permissionCatalog());
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addRole() {
    if (!name) return;
    try {
      await api.createRole(name, selectedPermissions);
      setName('');
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
        <TextInput value={name} onChange={(e) => setName(e.target.value)} className="mb-3" />
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

// ---- Packing ----------------------------------------------------------------

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
      <h3 className="font-semibold text-slate-900 mb-4">Packing charge rule</h3>
      <Label>Rule</Label>
      <select
        value={rule}
        onChange={(e) => setRule(e.target.value)}
        className="w-full mb-4 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
      >
        <option value="none">No charge</option>
        <option value="flat">Flat charge per order</option>
        <option value="per_item">Charge per item</option>
      </select>
      {rule === 'flat' && (
        <>
          <Label>Flat charge (₹)</Label>
          <TextInput
            type="number"
            value={flatCharge}
            onChange={(e) => setFlatCharge(e.target.value)}
            className="mb-4"
          />
        </>
      )}
      {rule === 'per_item' && (
        <>
          <Label>Charge per item (₹)</Label>
          <TextInput
            type="number"
            value={perItemCharge}
            onChange={(e) => setPerItemCharge(e.target.value)}
            className="mb-4"
          />
        </>
      )}
      <PrimaryButton onClick={save} className="w-full">
        {saved ? 'Saved ✓' : 'Save'}
      </PrimaryButton>
    </Card>
  );
}

// ---- Workflow ----------------------------------------------------------------

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

// ---- Devices ----------------------------------------------------------------

function DevicesTab({ onError }: { onError: (e: unknown) => void }) {
  const [deviceName, setDeviceName] = useState('');
  const [lastCredential, setLastCredential] = useState<{ name: string; credential: string } | null>(
    null,
  );

  async function register() {
    if (!deviceName) return;
    try {
      const res = await api.registerDevice(deviceName);
      setLastCredential({ name: res.device.name, credential: res.credential });
      setDeviceName('');
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="max-w-md space-y-6">
      <Card>
        <h3 className="font-semibold text-slate-900 mb-1">Register a counter device</h3>
        <p className="text-sm text-slate-500 mb-4">
          The credential is shown once — copy it into the counter device immediately.
        </p>
        <div className="flex gap-3">
          <TextInput
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Counter-01"
          />
          <SecondaryButton onClick={register}>Register</SecondaryButton>
        </div>
      </Card>
      {lastCredential && (
        <Card className="border-amber-200 bg-amber-50">
          <p className="text-sm font-semibold text-amber-900 mb-2">
            Credential for &ldquo;{lastCredential.name}&rdquo; — shown once
          </p>
          <code className="block bg-white border border-amber-300 rounded-lg p-3 text-xs break-all">
            {lastCredential.credential}
          </code>
        </Card>
      )}
    </div>
  );
}
