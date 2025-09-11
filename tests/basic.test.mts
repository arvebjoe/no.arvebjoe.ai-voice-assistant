import { describe, it, expect } from 'vitest';

describe('Basic Tests', () => {
  it('should perform basic arithmetic', () => {
    expect(2 + 2).toBe(4);
    expect(5 * 3).toBe(15);
    expect(10 - 4).toBe(6);
  });

  it('should handle string operations', () => {
    expect('hello'.toUpperCase()).toBe('HELLO');
    expect('world'.length).toBe(5);
    expect('test'.includes('es')).toBe(true);
  });

  it('should work with arrays', () => {
    const arr = [1, 2, 3];
    expect(arr.length).toBe(3);
    expect(arr.includes(2)).toBe(true);
    expect([...arr, 4]).toEqual([1, 2, 3, 4]);
  });
});
