import { useRef } from 'react';
import { Box, Text, useCursor, type DOMElement } from 'ink';
import { rectOf, useMouseArea } from '../hit.tsx';
import stringWidth from 'string-width';
import { fit, graphemes } from './text.ts';
import { ACCENT } from './theme.ts';

/**
 * Single-line input inside a rounded box. The real terminal cursor sits at the caret (so IMEs
 * compose in place); long text scrolls horizontally to keep the caret visible.
 */
export function TextInput({
  value,
  caret,
  focused,
  disabled,
  placeholder,
  ghost,
  mark = 0,
  width,
  onCaret,
  onFocus,
}: {
  value: string;
  caret: number;
  focused: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Completion shown dimmed after the text (when the caret is at the end). */
  ghost?: string;
  /** Leading graphemes shown in the theme colour (a recognised @command). */
  mark?: number;
  width: number;
  onCaret: (pos: number) => void;
  onFocus: () => void;
}) {
  const ref = useRef<DOMElement>(null);
  const { setCursorPosition } = useCursor();
  const inner = Math.max(4, width - 6); // border + "› " + one cell for the cursor
  const chars = graphemes(value);
  const caretG = Math.min(caret, chars.length);

  // Leftmost visible grapheme: scroll so the caret stays in view.
  let start = 0;
  while (stringWidth(chars.slice(start, caretG).join('')) > inner - 1) start++;
  let shown = '';
  for (const g of chars.slice(start)) {
    if (stringWidth(shown + g) > inner) break;
    shown += g;
  }

  const rect = rectOf(ref.current);
  if (focused && !disabled && rect) {
    setCursorPosition({ x: rect.x + stringWidth(chars.slice(start, caretG).join('')), y: rect.y });
  } else {
    setCursorPosition(undefined);
  }

  useMouseArea(ref, {
    onClick: (local) => {
      onFocus();
      // Map the clicked column to a caret position.
      let w = 0;
      let i = start;
      for (; i < chars.length; i++) {
        const gw = stringWidth(chars[i]!);
        if (w + gw / 2 > local.x) break;
        w += gw;
      }
      onCaret(i);
    },
  });

  return (
    <Box borderStyle="round" borderColor={focused && !disabled ? ACCENT : 'gray'} paddingX={1} width={width}>
      <Text color={focused && !disabled ? ACCENT : 'gray'}>› </Text>
      <Box ref={ref} flexGrow={1}>
        {value ? (
          <>
            {(() => {
              // The visible window may start inside the command; split there.
              const lead = Math.max(0, Math.min(mark - start, graphemes(shown).length));
              const g = graphemes(shown);
              return (
                <>
                  {lead > 0 ? (
                    <Text color={disabled ? 'gray' : ACCENT} bold={!disabled}>
                      {g.slice(0, lead).join('')}
                    </Text>
                  ) : null}
                  <Text color={disabled ? 'gray' : undefined}>{g.slice(lead).join('')}</Text>
                </>
              );
            })()}
            {ghost && caretG === chars.length ? <Text dimColor>{fit(ghost, Math.max(0, inner - stringWidth(shown) - 1))}</Text> : null}
          </>
        ) : (
          <Text dimColor>{fit(placeholder ?? '', inner)}</Text>
        )}
      </Box>
    </Box>
  );
}

// ---------- ListView ----------
