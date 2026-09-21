const fs = require('fs');
const http = require('http');
const { io } = require('socket.io-client');

const API_BASE = 'http://localhost:3001';

async function request(path, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const options = {
    method,
    headers,
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    body: body ? JSON.stringify(body) : null,
  });

  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Request ${method} ${path} failed (${res.status}): ${JSON.stringify(resBody)}`);
  }
  return resBody;
}

// 1x1 valid PNG image buffer
const VALID_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

async function runE2ETest() {
  console.log('========================================================');
  console.log('   Multi-Tenant SaaS - E2E Docker & Persistence Test');
  console.log('========================================================');

  // 1. Super Admin Login
  console.log('\n[Step 1] Logging in as Super Admin...');
  const saLogin = await request('/auth/super-admin/login', 'POST', {
    username: 'superadmin',
    password: 'SuperAdmin2026!',
  });
  const saToken = saLogin.accessToken;
  console.log('  -> Super Admin login successful.');

  // 2. Provision Tenant
  const runId = Math.random().toString(36).substring(2, 7);
  const shopName = `Docker_E2E_Shop_${runId}`;
  const shopAdminUsername = `admin_${runId}`;
  const shopAdminPassword = 'ShopPassword123!';

  console.log(`\n[Step 2] Provisioning new tenant: ${shopName}...`);
  const tenant = await request('/super-admin/tenants', 'POST', {
    displayName: shopName,
    businessType: 'Cafe',
    adminUsername: shopAdminUsername,
    adminPassword: shopAdminPassword,
    maxEmployees: 10,
    maxCounters: 2,
    maxCustomerDisplays: 2,
    maxPrinters: 2,
  }, saToken);
  console.log(`  -> Tenant provisioned! Code: ${tenant.code}, ID: ${tenant.id}`);

  // 3. Shop Admin Login
  console.log('\n[Step 3] Logging in as Shop Admin...');
  const shopLogin = await request('/auth/login', 'POST', {
    shopCode: tenant.code,
    username: shopAdminUsername,
    password: shopAdminPassword,
  });
  const shopToken = shopLogin.accessToken;
  console.log('  -> Shop Admin login successful.');

  // 4. Create Catalog & Upload Product Image
  console.log('\n[Step 4] Creating category & product with image upload...');
  const category = await request('/catalog/categories', 'POST', { name: 'Hot Beverages' }, shopToken);
  const product = await request('/catalog/products', 'POST', {
    name: 'Espresso Single',
    price: 150.00,
    categoryId: category.id,
  }, shopToken);
  console.log(`  -> Product created! ID: ${product.id}`);

  // Upload Product Image (multipart form)
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const multipartHeader = `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="espresso.png"\r\nContent-Type: image/png\r\n\r\n`;
  const multipartFooter = `\r\n--${boundary}--\r\n`;
  const bodyPayload = Buffer.concat([
    Buffer.from(multipartHeader),
    VALID_PNG_BUFFER,
    Buffer.from(multipartFooter),
  ]);

  const uploadRes = await fetch(`${API_BASE}/catalog/products/${product.id}/image`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${shopToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyPayload,
  });
  const uploadJson = await uploadRes.json();
  if (!uploadRes.ok) throw new Error(`Upload failed: ${JSON.stringify(uploadJson)}`);
  console.log(`  -> Product image uploaded successfully! Image URL: ${uploadJson.image_url}`);

  // Verify image stream endpoint returns 200 OK
  const imageFetchRes = await fetch(`${API_BASE}/catalog/products/${product.id}/image`, {
    headers: { 'Authorization': `Bearer ${shopToken}` },
  });
  if (imageFetchRes.status !== 200) throw new Error(`Fetch uploaded image failed with status ${imageFetchRes.status}`);
  console.log(`  -> Verified image stream endpoint returns HTTP 200 OK.`);

  // 5. Create Counter & Register TV Device
  console.log('\n[Step 5] Creating counter & registering TV Display device...');
  const counter = await request('/counters', 'POST', { name: 'Main Express Counter', code: 'C1' }, shopToken);
  const deviceReg = await request('/devices', 'POST', { name: 'Kitchen TV Display', type: 'customer_display' }, shopToken);
  const deviceId = deviceReg.device.id;
  const credential = deviceReg.credential;
  console.log(`  -> Counter created (${counter.name}), Device registered (ID: ${deviceId})`);

  // Connect TV Device to obtain device token
  const deviceConnect = await request('/devices/connect', 'POST', {
    deviceId,
    credential,
  });
  const deviceToken = deviceConnect.token;
  console.log('  -> TV Device authenticated successfully.');

  // 6. Connect WebSocket for TV Display
  console.log('\n[Step 6] Connecting WebSocket for TV Display realtime updates...');
  const socket = io(API_BASE, { auth: { token: deviceToken } });

  const wsEventPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket event timeout')), 8000);
    socket.on('order.status_changed', (payload) => {
      clearTimeout(timer);
      console.log(`  -> [WS REALTIME EVENT RECEIVED] Order status changed! New Status: ${payload.status}, Display Number: ${payload.displayNumber}`);
      resolve(payload);
    });
  });

  await new Promise((resolve) => socket.on('connect', resolve));
  console.log('  -> WebSocket connected to server room successfully.');

  // 7. Counter Creates Order
  console.log('\n[Step 7] Counter creating new order...');
  const idempotencyKey = require('crypto').randomUUID();
  const order = await request('/orders', 'POST', {
    idempotencyKey,
    items: [{ productId: product.id, quantity: 2 }],
    orderType: 'dine_in',
  }, shopToken);
  console.log(`  -> Order created! Order #${order.order_number}, Token #${order.display_number}, Total: ₹${order.total}`);

  // 8. Order Coordinator advances status to PREPARING
  console.log('\n[Step 8] Coordinator advancing order status to PREPARING...');
  const preparingOrder = await request(`/orders/${order.id}/status`, 'POST', { status: 'PREPARING' }, shopToken);
  console.log(`  -> Order status updated to ${preparingOrder.status}`);

  // 9. Kitchen advances status to READY (Triggers WebSocket event)
  console.log('\n[Step 9] Kitchen marking order READY...');
  await request(`/orders/${order.id}/status`, 'POST', { status: 'READY' }, shopToken);
  
  // Wait for WS event
  await wsEventPromise;
  socket.close();

  // Save verification data for persistence test
  const testData = {
    tenantId: tenant.id,
    tenantCode: tenant.code,
    shopAdminUsername,
    shopAdminPassword,
    productId: product.id,
    orderId: order.id,
    orderNumber: order.order_number,
    displayNumber: order.display_number,
  };
  fs.writeFileSync('./scratch/test-verification-data.json', JSON.stringify(testData, null, 2));

  console.log('\n========================================================');
  console.log('   All 12 E2E Workflow Steps Passed Successfully! ');
  console.log('========================================================');
}

runE2ETest().catch((err) => {
  console.error('\nE2E Test Failed:', err);
  process.exit(1);
});
