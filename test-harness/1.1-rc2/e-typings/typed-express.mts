// Round (e), with express and its types: the router with grouping on, as an app writes it.
import express from 'express';
import { jsonSchemaAdapter } from 'sheet-to-schema';
import { createImportRouter, type ImportBinding } from 'sheet-to-schema/node';
import { mount } from './typed-common.mjs';

const adapter = jsonSchemaAdapter({ type: 'object', properties: { orderId: { type: 'string' } } });
const orders: ImportBinding = { adapter, ctx: undefined };

const app = express();
app.use(
  '/import',
  createImportRouter(express.Router(), {
    bindings: { orders },
    grouping: true,
    limits: { maxGroupRows: 5_000 },
    onImport: async (records, { request }) => {
      const tenant: string | undefined = (request as express.Request).header('x-tenant');
      void tenant;
      void records;
    },
  }),
);
app.use('/import-2', mount(express.Router(), { bindings: { orders }, onImport: () => undefined }));
export default app;
