import { Injectable, Module } from '@nestjs/common';

export interface ReceiptData {
  shopName: string;
  orderNumber: string;
  displayNumber: string;
  date: string;
  time: string;
  servedBy: string;
  username: string;
  items: { name: string; quantity: number; lineTotal: number }[];
  packingCharge: number;
  discount: number;
  total: number;
}

export interface PrinterAdapter {
  print(receipt: ReceiptData): Promise<{ success: boolean; error?: string }>;
}

/**
 * PRINTER INTEGRATION STATUS (explicit, per project policy of never
 * claiming untested functionality works):
 *
 * TESTED: the abstraction boundary itself — OrdersService never calls a
 * printer directly; printing is a client-side action taken after order
 * creation succeeds, matching the "save first, print second" rule
 * (blueprint §29). This separation is exercised by the reprint tests in
 * test/integration/orders-e2e.spec.ts (reprint returns stored data,
 * creates no new order, allocates no new number).
 *
 * NOT PHYSICALLY TESTED: any actual printer output. No physical thermal
 * printer, virtual/emulated ESC-POS device, or vendor SDK was available
 * in this build environment. MockPrinterAdapter below logs what WOULD be
 * sent to a printer and always reports success — it has not been
 * exercised against real hardware, a print spooler, or even a software
 * ESC/POS emulator, and must not be presented as if it had been.
 *
 * A real deployment implements PrinterAdapter against the shop's actual
 * printer protocol (commonly ESC/POS over USB/network) behind this same
 * interface. No other part of the codebase needs to change — callers
 * only depend on the PrinterAdapter interface via the PRINTER_ADAPTER
 * injection token, never on MockPrinterAdapter directly.
 */

@Injectable()
export class MockPrinterAdapter implements PrinterAdapter {
  async print(receipt: ReceiptData) {
    // eslint-disable-next-line no-console
    console.log('[MockPrinterAdapter] would print receipt:', JSON.stringify(receipt, null, 2));
    return { success: true };
  }
}

export const PRINTER_ADAPTER = 'PRINTER_ADAPTER';

@Module({
  providers: [{ provide: PRINTER_ADAPTER, useClass: MockPrinterAdapter }],
  exports: [PRINTER_ADAPTER],
})
export class PrinterModule {}
