import { registerAs } from '@nestjs/config';

// App-wide configuration (currently empty, but can be extended)
export class AppConfig {
  // Add app-wide settings here as needed
}

export default registerAs('app', (): AppConfig => ({
  // Future app-wide configuration
}));