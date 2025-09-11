import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockHomey } from './mocks/mock-homey.mjs';

describe('MockHomey', () => {
  let mockHomey: MockHomey;

  beforeEach(() => {
    mockHomey = new MockHomey();
  });

  describe('Timer Methods', () => {
    it('should call setTimeout and return a timeout ID', () => {
      const callback = vi.fn();
      const timeoutId = mockHomey.setTimeout(callback, 100);
      
      expect(timeoutId).toBeDefined();
      expect(typeof timeoutId).toBe('object'); // NodeJS.Timeout is an object
      
      // Clean up
      mockHomey.clearTimeout(timeoutId);
    });

    it('should execute setTimeout callback after delay', async () => {
      const callback = vi.fn();
      
      mockHomey.setTimeout(callback, 10);
      
      // Wait a bit longer than the timeout
      await new Promise(resolve => setTimeout(resolve, 20));
      
      expect(callback).toHaveBeenCalledOnce();
    });

    it('should call setTimeout with arguments', async () => {
      const callback = vi.fn();
      const arg1 = 'test';
      const arg2 = 42;
      
      mockHomey.setTimeout(callback, 10, arg1, arg2);
      
      // Wait for the timeout to execute
      await new Promise(resolve => setTimeout(resolve, 20));
      
      expect(callback).toHaveBeenCalledWith(arg1, arg2);
    });

    it('should clear timeout correctly', () => {
      const callback = vi.fn();
      const timeoutId = mockHomey.setTimeout(callback, 100);
      
      mockHomey.clearTimeout(timeoutId);
      
      // Wait longer than the original timeout would have been
      return new Promise(resolve => {
        setTimeout(() => {
          expect(callback).not.toHaveBeenCalled();
          resolve(undefined);
        }, 150);
      });
    });

    it('should call setInterval and return an interval ID', () => {
      const callback = vi.fn();
      const intervalId = mockHomey.setInterval(callback, 50);
      
      expect(intervalId).toBeDefined();
      expect(typeof intervalId).toBe('object'); // NodeJS.Timeout is an object
      
      // Clean up
      mockHomey.clearInterval(intervalId);
    });

    it('should execute setInterval callback repeatedly', async () => {
      const callback = vi.fn();
      
      const intervalId = mockHomey.setInterval(callback, 20);
      
      // Wait for multiple intervals
      await new Promise(resolve => setTimeout(resolve, 70));
      
      mockHomey.clearInterval(intervalId);
      
      // Should have been called multiple times (at least 2 times in 70ms with 20ms interval)
      expect(callback.mock.calls.length).toBeGreaterThan(1);
    });

    it('should call setInterval with arguments', async () => {
      const callback = vi.fn();
      const arg1 = 'interval';
      const arg2 = 99;
      
      const intervalId = mockHomey.setInterval(callback, 20, arg1, arg2);
      
      // Wait for at least one interval
      await new Promise(resolve => setTimeout(resolve, 30));
      
      mockHomey.clearInterval(intervalId);
      
      expect(callback).toHaveBeenCalledWith(arg1, arg2);
    });

    it('should clear interval correctly', async () => {
      const callback = vi.fn();
      const intervalId = mockHomey.setInterval(callback, 20);
      
      // Let it run once
      await new Promise(resolve => setTimeout(resolve, 30));
      const callCountAfterFirstInterval = callback.mock.calls.length;
      
      // Clear the interval
      mockHomey.clearInterval(intervalId);
      
      // Wait some more time
      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Should not have been called again after clearing
      expect(callback.mock.calls.length).toBe(callCountAfterFirstInterval);
    });
  });
});
