import { registerAs } from '@nestjs/config';

// App-wide configuration
export class AppConfig {
  // Add app-wide settings here as needed
}

export default registerAs('app', (): AppConfig => {
  return new AppConfig();
});