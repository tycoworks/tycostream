/**
 * Truncate data for logging to avoid huge log entries
 */
export function truncateForLog(data: any, maxLength = 100): string {
  const str = JSON.stringify(data);
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + '...';
}