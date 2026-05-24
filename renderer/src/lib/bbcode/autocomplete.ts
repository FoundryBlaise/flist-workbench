import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'

// Fixed list lifted from F-Chat 3.0's BBCode grammar (see `mockups/`
// reference + the renderer in lib/bbcode/index.ts). Order is the order
// the suggestion list shows them.
const BBCODE_TAGS: { name: string; detail: string; hasValue?: boolean; selfClosing?: boolean }[] = [
  { name: 'b', detail: 'Bold' },
  { name: 'i', detail: 'Italic' },
  { name: 'u', detail: 'Underline' },
  { name: 's', detail: 'Strikethrough' },
  { name: 'sub', detail: 'Subscript' },
  { name: 'sup', detail: 'Superscript' },
  { name: 'big', detail: 'Larger text' },
  { name: 'small', detail: 'Smaller text' },
  { name: 'color', detail: 'Coloured text — use [color=red]…[/color]', hasValue: true },
  { name: 'url', detail: 'Hyperlink — use [url=https://…]…[/url]', hasValue: true },
  { name: 'user', detail: 'F-list user link' },
  { name: 'icon', detail: 'Character icon' },
  { name: 'eicon', detail: 'Emote icon' },
  { name: 'img', detail: 'Inline image — use [img=ID]…[/img]', hasValue: true },
  { name: 'heading', detail: 'Profile heading' },
  { name: 'quote', detail: 'Quoted block' },
  { name: 'spoiler', detail: 'Spoiler — hidden until hover' },
  { name: 'noparse', detail: 'Show BBCode literally without parsing' },
  { name: 'collapse', detail: 'Collapsible section — use [collapse=Title]…[/collapse]', hasValue: true },
  { name: 'center', detail: 'Centre text' },
  { name: 'left', detail: 'Left-align text' },
  { name: 'right', detail: 'Right-align text' },
  { name: 'justify', detail: 'Justify text' },
  { name: 'indent', detail: 'Indent block' },
  { name: 'hr', detail: 'Horizontal rule', selfClosing: true }
]

// F-list's twelve named colours. Anything else falls through to the
// transformer's "literal text" branch.
const NAMED_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'purple',
  'pink',
  'black',
  'brown',
  'white',
  'gray'
]

function tagCompletions(): Completion[] {
  return BBCODE_TAGS.map((tag) => {
    if (tag.selfClosing) {
      return {
        label: `[${tag.name}]`,
        type: 'keyword',
        detail: tag.detail,
        apply: `[${tag.name}]`
      }
    }
    if (tag.hasValue) {
      return {
        label: `[${tag.name}=]`,
        type: 'keyword',
        detail: tag.detail,
        // Insert the opening with a placeholder so the cursor lands
        // between the `=` and `]`. Users typically tab through to fill
        // the value then continue typing the body.
        apply: `[${tag.name}=]`
      }
    }
    return {
      label: `[${tag.name}]`,
      type: 'keyword',
      detail: tag.detail,
      apply: `[${tag.name}][/${tag.name}]`
    }
  })
}

function colorCompletions(): Completion[] {
  return NAMED_COLORS.map((name) => ({
    label: name,
    type: 'enum',
    detail: 'F-list named colour',
    apply: name
  }))
}

const TAG_COMPLETIONS = tagCompletions()
const COLOR_COMPLETIONS = colorCompletions()

// Trigger inside `[…` so the suggestion list shows what tags exist.
// Match the bracket itself so typing `[` opens the menu.
const OPEN_TAG_RE = /\[(\/?[a-zA-Z0-9]*)$/

// `[color=…` — list named colours after the equals sign.
const COLOR_VALUE_RE = /\[color=([a-zA-Z]*)$/

function bbcodeCompletionSource(context: CompletionContext): CompletionResult | null {
  // Colour values get priority — `[color=` matches the open-tag regex
  // too, but offering the colour list is much more useful here.
  const colorMatch = context.matchBefore(COLOR_VALUE_RE)
  if (colorMatch) {
    return {
      from: colorMatch.from + '[color='.length,
      options: COLOR_COMPLETIONS,
      validFor: /^[a-zA-Z]*$/
    }
  }
  const tagMatch = context.matchBefore(OPEN_TAG_RE)
  if (!tagMatch) return null
  // Don't pop the menu the very instant the user types `[` unless they
  // explicitly invoked completion — otherwise it's noisy. Once they
  // type any letter after `[`, autosuggest.
  if (tagMatch.text === '[' && !context.explicit) return null
  return {
    from: tagMatch.from,
    options: TAG_COMPLETIONS,
    validFor: /^\[\/?[a-zA-Z0-9]*$/
  }
}

export const bbcodeAutocomplete = autocompletion({
  override: [bbcodeCompletionSource],
  // Show on every keystroke (including `[`) — gives the editor the
  // "type-ahead" feel users expect from a 2026-era code editor.
  activateOnTyping: true,
  // Quietly close the menu when the user types whitespace or a closing
  // bracket — the suggestion is done helping.
  closeOnBlur: true,
  defaultKeymap: true
})
