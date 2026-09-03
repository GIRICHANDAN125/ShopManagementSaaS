/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

const PERMISSION_CODES = [
  'order.create',
  'order.view',
  'order.cancel',
  'receipt.print',
  'receipt.reprint',
  'product.manage',
  'inventory.manage',
  'employee.manage',
  'shop.settings',
  'reports.view',
  'device.manage',
];

exports.up = (pgm) => {
  for (const code of PERMISSION_CODES) {
    pgm.sql(`INSERT INTO permissions (code) VALUES ('${code}') ON CONFLICT (code) DO NOTHING;`);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM permissions WHERE code = ANY(ARRAY[${PERMISSION_CODES.map((c) => `'${c}'`).join(',')}]);`);
};
