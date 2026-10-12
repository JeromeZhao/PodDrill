# Speaker assignment

Read cues with `cues`. Write labels with `labelGroups`. The CLI names are `poddrill cues` and `poddrill label-groups`.

A group id looks like `gc0001`. It is one voice. The same name on two groups is one person. A page holds 8 cues unless you pass a limit. The limit cannot be above 20. Pass `groupId` to read one group. Pass `after` with a cue id to read the next page. Pass `hosts` to get host names. That list leaves out `quote` and `ending`.

A label is a name, `undetermined`, `quote`, or `ending`. Send only the groups you are changing.

## Heuristics You May Use

These are suggestions, not rules. Use your best information and judgement.

- A self-referencing introduction that then gives a name may belong to that voice group. In English that can be "I'm".
- If a voice group says another person's name in two or more lines, that name may not be the group. One mention can be a stray line. If one name is left, it may be the one to use.
- If the lines just before a voice group say a clip is about to play, the group may be a quote. Read the line before it and the line after it.
- If the hosts have said goodbye and the next lines are a song or a short sign-off, those lines may be the ending. They may stay without a host name.

## When to stop

About 95 percent of spoken time with a host name is enough. Leave the remaining cues `undetermined`. That does not block later work.

Do not copy a name from the nearest group. Do not match a repeated phrase. Do not guess from a handoff. Do not use show notes.
