/** Error raised by the stream-filter layer (§7.4). */
export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterError';
  }
}
