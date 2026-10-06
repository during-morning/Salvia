import { useRef, useState, type ReactNode } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import { useMouseArea } from '../hit.tsx';
import { ACCENT } from '../widgets/index.ts';

/** A clickable one-line row (task area, download list); highlighted when selected or hovered. */
export function TaskLine({ width, selected, onPress, children }: { width: number; selected: boolean; onPress: () => void; children: ReactNode }) {
  const ref = useRef<DOMElement>(null);
  const [hover, setHover] = useState(false);
  useMouseArea(ref, { onClick: onPress, onHover: () => setHover(true), onLeave: () => setHover(false) });
  return (
    <Box ref={ref} width={width}>
      <Text color={ACCENT}>{selected || hover ? '›' : ' '}</Text>
      <Box width={width - 1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}
