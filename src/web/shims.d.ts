/**
 * TYPECHECK SHIM, NOT THE REAL REACT TYPES. `@types/react` cannot be installed in the offline build sandbox, so this
 * file declares the small subset of React the dashboard uses, with real signatures for hooks. Intrinsic element props
 * are `any`, so JSX attribute typos are NOT caught here. On a machine with npm access run:
 *   npm i -D @types/react @types/react-dom   and delete this file (tsconfig.web.json then typechecks fully).
 */
declare module 'react' {
  export type ReactNode = unknown;
  export type Dispatch<A> = (value: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);
  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useCallback<F extends (...args: any[]) => any>(fn: F, deps: readonly unknown[]): F;
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T;
  export function useId(): string;
  export interface Context<T> {
    Provider: (props: { value: T; children?: ReactNode }) => any;
  }
  export function createContext<T>(defaultValue: T): Context<T>;
  export function useContext<T>(ctx: Context<T>): T;
  export function Fragment(props: { children?: ReactNode }): any;
  export const StrictMode: (props: { children?: ReactNode }) => any;
}
declare module 'react-dom/client' {
  export function createRoot(el: Element | null): { render(node: unknown): void; unmount(): void };
}
declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
  export namespace JSX {
    interface Element {}
    interface ElementChildrenAttribute { children: {} }
    interface IntrinsicAttributes { key?: string | number }
    interface IntrinsicElements { [name: string]: any }
  }
}
