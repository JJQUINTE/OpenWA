import { NotFoundException, NotImplementedException } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import type { SendPacingService } from '../message/send-pacing.service';
import type {
  IWhatsAppEngine,
  Catalog,
  Product,
  PaginatedProducts,
  MessageResult,
} from '../../engine/interfaces/whatsapp-engine.interface';

const catalog: Catalog = { id: 'cat-1', name: 'Toko Kue', productCount: 2, url: 'https://wa.me/c/628123' };
const product: Product = {
  id: 'prod-1',
  name: 'Brownies',
  price: 25000,
  currency: 'IDR',
  priceFormatted: 'Rp25.000',
  url: 'https://wa.me/p/prod-1/628123',
  isAvailable: true,
};
const page: PaginatedProducts = { products: [product], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
const sent: MessageResult = { id: 'wamid.product', timestamp: 1_706_868_000 };

describe('CatalogService', () => {
  const makeService = (engine: Partial<IWhatsAppEngine> | undefined, pacing?: { assertSendAllowed: jest.Mock }) => {
    const engines = new EngineRegistry();
    if (engine) engines.set('s1', engine as IWhatsAppEngine);
    const sendPacing = {
      assertSendAllowed: jest.fn().mockResolvedValue(undefined),
      recordSendSuccess: jest.fn(),
      recordSendFailure: jest.fn(),
      ...pacing,
    };
    return { svc: new CatalogService(engines, sendPacing as unknown as SendPacingService), pacing: sendPacing };
  };

  describe('catalog reads', () => {
    it.each(['getCatalog', 'getProducts', 'getProduct'] as const)(
      'rejects with 404 for %s when the session is not started',
      async method => {
        const { svc } = makeService(undefined);
        const promise =
          method === 'getProduct'
            ? svc.getProduct('s1', 'prod-1')
            : method === 'getProducts'
              ? svc.getProducts('s1')
              : svc.getCatalog('s1');
        await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it('delegates getCatalog to the engine and returns its answer (null when the account has none)', async () => {
      const getCatalog = jest.fn().mockResolvedValue(catalog);
      const { svc } = makeService({ getCatalog });
      await expect(svc.getCatalog('s1')).resolves.toBe(catalog);

      getCatalog.mockResolvedValue(null);
      await expect(svc.getCatalog('s1')).resolves.toBeNull();
    });

    it('delegates getProducts with the requested page window', async () => {
      const getProducts = jest.fn().mockResolvedValue(page);
      const { svc } = makeService({ getProducts });
      await expect(svc.getProducts('s1', 3, 50)).resolves.toBe(page);
      expect(getProducts).toHaveBeenCalledWith({ page: 3, limit: 50 });
    });

    it('defaults getProducts to the first page of 20', async () => {
      const getProducts = jest.fn().mockResolvedValue(page);
      await makeService({ getProducts }).svc.getProducts('s1');
      expect(getProducts).toHaveBeenCalledWith({ page: 1, limit: 20 });
    });

    it('delegates getProduct and passes an unknown id through as null (not a 404)', async () => {
      const getProduct = jest.fn().mockResolvedValue(null);
      await expect(makeService({ getProduct }).svc.getProduct('s1', 'prod-404')).resolves.toBeNull();
      expect(getProduct).toHaveBeenCalledWith('prod-404');
    });

    it('propagates an engine failure instead of reporting an empty catalog', async () => {
      const down = new NotImplementedException('catalog query unanswered');
      const getCatalog = jest.fn().mockRejectedValue(down);
      await expect(makeService({ getCatalog }).svc.getCatalog('s1')).rejects.toBe(down);
    });
  });

  describe('product-message sends', () => {
    it.each(['sendProduct', 'sendCatalog'] as const)(
      'rejects with 404 for %s when the session is not started',
      async method => {
        const { svc } = makeService(undefined);
        const promise =
          method === 'sendProduct'
            ? svc.sendProduct('s1', '628123@c.us', 'prod-1')
            : svc.sendCatalog('s1', '628123@c.us');
        await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it('paces a product send BEFORE it reaches the engine', async () => {
      const order: string[] = [];
      const pacing = {
        assertSendAllowed: jest.fn().mockImplementation(() => {
          order.push('pace');
          return Promise.resolve();
        }),
      };
      const sendProduct = jest.fn().mockImplementation(() => {
        order.push('send');
        return Promise.resolve(sent);
      });
      const { svc } = makeService({ sendProduct }, pacing);

      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1', 'Back in stock!')).resolves.toBe(sent);
      expect(order).toEqual(['pace', 'send']);
      expect(pacing.assertSendAllowed).toHaveBeenCalledWith('s1', '628123@c.us');
      expect(sendProduct).toHaveBeenCalledWith('628123@c.us', 'prod-1', 'Back in stock!');
    });

    // No engine can send a catalog link today — the route stays live (and paced) so the day one
    // gains support the send is not unpaced, but until then the adapter's 501 must reach the
    // caller unchanged. Pin the refusal; do not "fix" it into a success.
    it('sendCatalog surfaces the engine’s deliberate 501 unchanged', async () => {
      const pacing = { assertSendAllowed: jest.fn().mockResolvedValue(undefined) };
      const unsupported = new EngineNotSupportedError('sendCatalog');
      const sendCatalog = jest.fn().mockRejectedValue(unsupported);
      const { svc } = makeService({ sendCatalog }, pacing);

      await expect(svc.sendCatalog('s1', '628123@c.us', 'Browse our catalog')).rejects.toBe(unsupported);
      expect(unsupported.getStatus()).toBe(501);
      expect(pacing.assertSendAllowed).toHaveBeenCalledWith('s1', '628123@c.us');
      expect(sendCatalog).toHaveBeenCalledWith('628123@c.us', 'Browse our catalog');
    });

    it('propagates an engine failure from sendProduct', async () => {
      const down = new Error('socket closed');
      const sendProduct = jest.fn().mockRejectedValue(down);
      await expect(makeService({ sendProduct }).svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toBe(down);
    });

    it('reports the engine outcome of a product send to the pacing breaker', async () => {
      const sendProduct = jest.fn().mockResolvedValue(sent);
      const { svc, pacing } = makeService({ sendProduct });
      await svc.sendProduct('s1', '628123@c.us', 'prod-1');
      expect(pacing.recordSendSuccess).toHaveBeenCalledWith('s1');

      const refused = new EngineRefusedError('refused');
      sendProduct.mockRejectedValue(refused);
      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-1')).rejects.toBe(refused);
      expect(pacing.recordSendFailure).toHaveBeenCalledWith('s1');
    });

    it('does not feed a client-fault or unsupported refusal to the breaker', async () => {
      const sendProduct = jest.fn().mockRejectedValue(new NotFoundException('Product not found'));
      const sendCatalog = jest.fn().mockRejectedValue(new EngineNotSupportedError('sendCatalog'));
      const { svc, pacing } = makeService({ sendProduct, sendCatalog });
      await expect(svc.sendProduct('s1', '628123@c.us', 'prod-404')).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.sendCatalog('s1', '628123@c.us')).rejects.toBeInstanceOf(EngineNotSupportedError);
      expect(pacing.recordSendFailure).not.toHaveBeenCalled();
    });
  });
});
