import * as express from 'express';
import { Server } from 'http';

/**
 * Webhook endpoint operations
 */
export interface WebhookEndpoint {
  register: (endpoint: string, handler: (payload: any) => Promise<void>) => string;
  unregister: (endpoint: string) => void;
}

/**
 * Manages a webhook server for testing
 * Handles dynamic registration/unregistration of webhook endpoints
 */
export class WebhookServer implements WebhookEndpoint {
  private app: express.Application;
  private server: Server;
  private handlers = new Map<string, (payload: any) => Promise<void>>();
  private port: number;
  
  constructor(port: number) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    
    // Single wildcard route that dynamically looks up handlers
    this.app.post('*', async (req, res) => {
      const handler = this.handlers.get(req.path);
      if (!handler) {
        res.status(404).send('Webhook not found');
        return;
      }
      
      try {
        await handler(req.body);
        res.status(200).send('OK');
      } catch (error) {
        console.error('Webhook handler error:', error);
        res.status(500).send('Handler error');
      }
    });
  }
  
  /**
   * Start the webhook server
   */
  start(): void {
    this.server = this.app.listen(this.port);
  }
  
  /**
   * Stop the webhook server
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      console.log('Webhook server stopped');
    }
  }
  
  /**
   * Register a webhook endpoint
   */
  register(endpoint: string, handler: (payload: any) => Promise<void>): string {
    this.handlers.set(endpoint, handler);
    return `http://localhost:${this.port}${endpoint}`;
  }
  
  /**
   * Unregister a webhook endpoint
   */
  unregister(endpoint: string): void {
    this.handlers.delete(endpoint);
  }
}