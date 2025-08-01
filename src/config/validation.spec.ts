import { IsString, IsNumber, Min } from 'class-validator';
import { validateConfig } from './validation';

class TestConfig {
  @IsString()
  name: string;

  @IsNumber()
  @Min(0)
  value: number;
}

describe('ConfigValidation', () => {
  it('should validate correct configuration', () => {
    const config = { name: 'test', value: 10 };
    const result = validateConfig(config, 'test', TestConfig);
    
    expect(result).toBeInstanceOf(TestConfig);
    expect(result.name).toBe('test');
    expect(result.value).toBe(10);
  });

  it('should throw error for invalid configuration', () => {
    const config = { name: '', value: -1 };
    
    expect(() => {
      validateConfig(config, 'test', TestConfig);
    }).toThrow('Invalid configuration for test');
  });

  it('should throw error for missing required fields', () => {
    const config = { value: 10 };
    
    expect(() => {
      validateConfig(config, 'test', TestConfig);
    }).toThrow('Invalid configuration for test');
  });
});