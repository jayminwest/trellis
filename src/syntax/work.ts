/** Optional operation/storage accounting for consumers of shared syntax helpers.
 * The syntax layer owns no budgets and depends on no analyzer implementation.
 */
export interface SyntaxWork {
	charge(units?: number): void;
	reserve(cells: number): void;
	release(cells: number): void;
}
