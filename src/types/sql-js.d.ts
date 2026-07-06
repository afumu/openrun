declare module 'sql.js' {
  export type SqlValue = string | number | Uint8Array | null;
  export type ParamsObject = Record<string, SqlValue>;
  export type ParamsCallback = (obj: ParamsObject) => void;

  export type QueryExecResult = {
    columns: string[];
    values: SqlValue[][];
  };

  export class Statement {
    bind(values?: SqlValue[] | ParamsObject): boolean;
    step(): boolean;
    getAsObject(): ParamsObject;
    free(): boolean;
  }

  export class Database {
    constructor(data?: Uint8Array);
    run(sql: string, params?: SqlValue[] | ParamsObject): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string, params?: SqlValue[] | ParamsObject): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export type SqlJsStatic = {
    Database: typeof Database;
  };

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
