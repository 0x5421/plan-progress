import type { ClientModule } from 'claude-code'

// "Progress ⚙" in the prompt footer, drawn as plain text like the model name beside it.
// A desktop draws every Button with native chrome (a grey box that also clipped the "g"),
// so this region draws Text and reports clicks itself: on the label it toggles the bars,
// on the gear it opens the style pane.
export type FooterProps = { label: string; gear: string; isDim: boolean }

const Footer: ClientModule<FooterProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  // the label, one space, then the gear: a click at or right of the space opens the pane
  const gearFrom = [...props.label].length
  surface.onPointer(e => {
    if (e.type !== 'up') return
    surface.post({ action: e.x >= gearFrom ? 'styles' : 'toggle' })
  })

  return (
    <Box flexDirection="row">
      <Text dimColor={props.isDim}>{props.label}</Text>
      <Text> </Text>
      <Text>{props.gear}</Text>
    </Box>
  )
}

export default Footer
