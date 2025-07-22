import { StreamBuffer } from './stream-buffer';

describe('StreamBuffer', () => {
  let buffer: StreamBuffer;

  beforeEach(() => {
    buffer = new StreamBuffer();
  });

  describe('processChunk', () => {
    it('should handle complete lines', () => {
      const chunk = Buffer.from('line1\nline2\nline3\n');
      const lines = buffer.processChunk(chunk);
      
      expect(lines).toEqual(['line1', 'line2', 'line3']);
      expect(buffer.remainingBuffer).toBe('');
    });

    it('should handle incomplete last line', () => {
      const chunk = Buffer.from('line1\nline2\nincomplete');
      const lines = buffer.processChunk(chunk);
      
      expect(lines).toEqual(['line1', 'line2']);
      expect(buffer.remainingBuffer).toBe('incomplete');
    });

    it('should handle multiple chunks with incomplete lines', () => {
      const chunk1 = Buffer.from('line1\nline2\nincomp');
      const chunk2 = Buffer.from('lete\nline3\n');
      
      const lines1 = buffer.processChunk(chunk1);
      expect(lines1).toEqual(['line1', 'line2']);
      
      const lines2 = buffer.processChunk(chunk2);
      expect(lines2).toEqual(['incomplete', 'line3']);
    });

    it('should handle empty chunks', () => {
      const chunk = Buffer.from('');
      const lines = buffer.processChunk(chunk);
      
      expect(lines).toEqual([]);
      expect(buffer.remainingBuffer).toBe('');
    });

    it('should handle chunks with only newlines', () => {
      const chunk = Buffer.from('\n\n\n');
      const lines = buffer.processChunk(chunk);
      
      expect(lines).toEqual(['', '', '']);
      expect(buffer.remainingBuffer).toBe('');
    });
  });

  describe('clear', () => {
    it('should clear the buffer', () => {
      buffer.processChunk(Buffer.from('incomplete'));
      expect(buffer.remainingBuffer).toBe('incomplete');
      
      buffer.clear();
      expect(buffer.remainingBuffer).toBe('');
    });
  });
});