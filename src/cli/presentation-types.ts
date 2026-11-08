/** Shared public types for the terminal presentation helpers. */

export type ColorMode = 'auto' | 'always' | 'never'

export type Alignment = 'left' | 'center' | 'right'

export type SemanticStyle =
  | 'title'
  | 'section'
  | 'label'
  | 'value'
  | 'muted'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'accent'

export type TerminalOutput = {
  readonly isTTY?: boolean
  readonly columns?: number
}

export type PresentationOptions = {
  /** `auto` is the default. A boolean is accepted for convenient callers. */
  readonly color?: ColorMode | boolean
  /** Environment is injectable so color and Unicode decisions are deterministic. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly isTTY?: boolean
  readonly output?: TerminalOutput
  readonly columns?: number
  readonly width?: number
  /** Override the conservative Unicode-symbol capability check. */
  readonly unicode?: boolean
}

export type TableColumn<Row> = {
  readonly key?: string
  readonly header: string
  readonly get?: (row: Row, rowIndex: number) => unknown
  readonly accessor?: (row: Row, rowIndex: number) => unknown
  readonly format?: (value: unknown, row: Row, rowIndex: number) => string
  readonly align?: Alignment
  /** Larger values retain the column first and receive space first. */
  readonly priority?: number
  /** Optional columns are removed when their minimum widths cannot fit. */
  readonly optional?: boolean
  /** Minimum display width; defaults to the full value width for adaptive tables. */
  readonly minWidth?: number
}

export type TablePresentationOptions = Omit<PresentationOptions, 'columns'>

export type TableRenderOptions<Row> = TablePresentationOptions & {
  readonly rows: readonly Row[]
  readonly columns: readonly TableColumn<Row>[]
  readonly gap?: number
  readonly header?: boolean
  readonly separator?: boolean
  readonly headerStyle?: SemanticStyle | false
}

export type TableCallOptions = Omit<TableRenderOptions<never>, 'rows' | 'columns'>

export type KeyValueEntry = {
  readonly key?: string
  readonly label?: string
  readonly value: unknown
}

export type KeyValueOptions = PresentationOptions & {
  readonly labelWidth?: number
  readonly separator?: string
  readonly labelStyle?: SemanticStyle | false
  readonly valueStyle?: SemanticStyle | false
  readonly emptyValue?: string
}

export type StatusOptions = PresentationOptions & {
  readonly symbol?: boolean
}

export type WrapTextOptions = {
  /** Repeat leading whitespace on continuation lines. */
  readonly preserveIndent?: boolean
}

export type StatusKind = 'success' | 'warning' | 'error' | 'info' | 'muted'

export type LocalTableOptions<Row> = Omit<
  TableRenderOptions<Row>,
  keyof TablePresentationOptions
> & {
  readonly width?: number
}

export type Presentation = {
  readonly color: boolean
  readonly width: number
  readonly style: (text: string, semanticStyle: SemanticStyle) => string
  readonly wrap: (
    text: string,
    width?: number,
    options?: WrapTextOptions
  ) => readonly string[]
  readonly title: (text: string) => string
  readonly section: (text: string) => string
  readonly keyValue: (
    entries: Readonly<Record<string, unknown>> | readonly KeyValueEntry[],
    options?: Omit<KeyValueOptions, keyof PresentationOptions>
  ) => string
  readonly status: (
    kind: StatusKind,
    message?: unknown,
    options?: Omit<StatusOptions, keyof PresentationOptions>
  ) => string
  readonly emptyState: (message?: string) => string
  readonly table: <Row>(options: LocalTableOptions<Row>) => string
}
