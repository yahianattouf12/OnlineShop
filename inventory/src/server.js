const path = require('node:path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { pool, initDatabase } = require('./db');
const inventory = require('./inventory');

// The same .proto file the main application uses: it is the contract between the two.
const PROTO_PATH = path.join(__dirname, '..', '..', 'proto', 'inventory.proto');

const definition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, // keep the field names of the .proto (product_id, not productId)
  defaults: true, // a missing field gets its default value (0, "", [])
});
const { InventoryService } = grpc.loadPackageDefinition(definition).inventory.v1;

/**
 * Turns an async function (request => reply) into a gRPC handler.
 * Errors we threw on purpose keep their status code. Anything else is a bug: it is logged,
 * and the client only gets INTERNAL, without the details (they could reveal internals).
 */
function handle(name, fn) {
  return (call, callback) => {
    fn(call.request)
      .then((reply) => callback(null, reply))
      .catch((err) => {
        if (err instanceof inventory.RpcError) return callback(err);
        console.error(`${name} failed:`, err);
        callback({ code: grpc.status.INTERNAL, message: 'Internal error in the inventory service.' });
      });
  };
}

async function main() {
  await initDatabase();

  const server = new grpc.Server();
  server.addService(InventoryService.service, {
    GetStock: handle('GetStock', inventory.getStock),
    Reserve: handle('Reserve', inventory.reserve),
    Release: handle('Release', inventory.release),
    SetStock: handle('SetStock', inventory.setStock),
  });

  const address = `0.0.0.0:${process.env.PORT ?? 50051}`;
  // Plain HTTP/2 without TLS: inside Docker only the app container talks to this service.
  server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      console.error('Could not listen:', err);
      process.exit(1);
    }
    console.log(`Inventory gRPC service listening on ${address}`);
  });

  // "docker compose stop" sends SIGTERM: finish the calls in progress, then exit.
  process.on('SIGTERM', () => {
    console.log('Stopping...');
    server.tryShutdown(() => pool.end().then(() => process.exit(0)));
  });
}

main().catch((err) => {
  console.error('Inventory service could not start:', err);
  process.exit(1);
});