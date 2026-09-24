<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way
out of this. </EXTREMELY-IMPORTANT>

## How to Access Skills

Pi advertises discovered skills by name, description, and file path. When one
applies, use `read` on its advertised SKILL.md path (without a query) and follow
the full instructions. Resolve referenced files relative to that skill's
directory. `/skill:name` also explicitly loads a skill when requested by a user.

If a skill is already loaded in the current context, do not reread it. After
compaction, reload only the skills still relevant to the outstanding task;
never copy skill contents into the summary.
