/* eslint-disable @typescript-eslint/no-var-requires */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT NULL;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE products DROP COLUMN IF EXISTS image_url;`);
};
