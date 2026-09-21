const fs = require('fs');

const API_BASE = 'http://localhost:3001';

async function request(path, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Request ${method} ${path} failed (${res.status}): ${JSON.stringify(resBody)}`);
  }
  return resBody;
}

async function runPersistenceCheck() {
  console.log('========================================================');
  console.log('   Multi-Tenant SaaS - Docker Persistence Verification');
  console.log('========================================================');

  const rawData = fs.readFileSync('./scratch/test-verification-data.json', 'utf8');
  const testData = JSON.parse(rawData);

  console.log(`Checking persistence for tenant: ${testData.tenantCode} (${testData.tenantId})`);

  // 1. Verify Super Admin can view the tenant
  console.log('\n[1] Verifying Super Admin access...');
  const saLogin = await request('/auth/super-admin/login', 'POST', {
    username: 'superadmin',
    password: 'SuperAdmin2026!',
  });
  const saToken = saLogin.accessToken;
  const tenants = await request('/super-admin/tenants', 'GET', null, saToken);
  const foundTenant = tenants.find(t => t.id === testData.tenantId);
  if (!foundTenant) throw new Error(`Tenant ${testData.tenantId} not found after restart!`);
  console.log(`  -> Database Persistence CONFIRMED: Tenant record '${foundTenant.display_name}' survived restart!`);

  // 2. Verify Shop Admin Login
  console.log('\n[2] Verifying Shop Admin login & catalog persistence...');
  const shopLogin = await request('/auth/login', 'POST', {
    shopCode: testData.tenantCode,
    username: testData.shopAdminUsername,
    password: testData.shopAdminPassword,
  });
  const shopToken = shopLogin.accessToken;

  const products = await request('/catalog/products', 'GET', null, shopToken);
  const foundProduct = products.find(p => p.id === testData.productId);
  if (!foundProduct) throw new Error(`Product ${testData.productId} not found after restart!`);
  console.log(`  -> Database Persistence CONFIRMED: Product '${foundProduct.name}' (₹${foundProduct.price}) survived restart!`);

  // 3. Verify Uploaded Image File Persistence on persistent volume
  console.log('\n[3] Verifying uploaded product image file persistence...');
  const imageRes = await fetch(`${API_BASE}/catalog/products/${testData.productId}/image`, {
    headers: { 'Authorization': `Bearer ${shopToken}` },
  });
  if (imageRes.status !== 200) {
    throw new Error(`Uploaded product image missing after container restart! HTTP ${imageRes.status}`);
  }
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  if (imageBuffer.length < 10) throw new Error('Uploaded image file corrupted or empty');
  console.log(`  -> Image Storage Persistence CONFIRMED: Product image file served successfully (${imageBuffer.length} bytes, HTTP 200 OK)!`);

  console.log('\n========================================================');
  console.log('   PERSISTENCE TEST 100% SUCCESSFUL! ALL DATA SURVIVED!');
  console.log('========================================================');
}

runPersistenceCheck().catch((err) => {
  console.error('\nPersistence Verification Failed:', err);
  process.exit(1);
});
