import type { DatabaseStreamer } from '../database/types.js';

export function createViewSubscriptionResolver(viewName: string) {
  return {
    subscribe: async function* (_parent: any, _args: any, context: any) {
      const { stream } = context;
      
      for await (const event of stream.getUpdates()) {
        yield { [viewName]: event.row };
      }
    },
    resolve: (payload: any) => payload[viewName],
  };
}

export function createViewQueryResolver() {
  return (_parent: any, _args: any, context: any) => {
    const { stream } = context;
    return stream.getAllRows();
  };
}