/**
 * Node sizing constants.
 *
 * A leaf node is wide enough for a title of a few words on one or two lines
 * beside its id and type, because the canvas is read at a glance and a
 * truncated title costs a click to recover.  A group needs room for its own
 * header and title above its children.
 */
export const NODE_WIDTH = 264;
export const NODE_HEIGHT = 96;
export const GROUP_HEADER = 64;
export const GROUP_PADDING = 24;
