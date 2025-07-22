/**
 * Stream buffer helper for handling line-based protocols over TCP
 * Manages incomplete lines across chunk boundaries
 */
export class StreamBuffer {
  private buffer = '';

  /**
   * Process a new chunk of stream data
   * @param chunk - The raw chunk from the stream
   * @returns Array of complete lines
   */
  processChunk(chunk: Buffer): string[] {
    // Convert buffer to UTF-8 string and combine with any buffered data
    const combined = this.buffer + chunk.toString('utf8');
    const lines = combined.split('\n');
    
    // Last "line" might be incomplete - save it for next chunk
    this.buffer = lines.pop() || '';
    
    return lines;
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer = '';
  }

  /**
   * Get any remaining buffered data
   */
  get remainingBuffer(): string {
    return this.buffer;
  }
}