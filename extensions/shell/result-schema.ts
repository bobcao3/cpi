import { Type } from "typebox";

export const shell_output_schema = Type.Object({
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("running"),
    Type.Literal("blocked"),
    Type.Literal("aborted"),
  ]),
  output: Type.String(),
  is_error: Type.Boolean(),
  exit_code: Type.Union([Type.Number(), Type.Null()]),
  id: Type.Union([Type.String(), Type.Null()]),
  full_output_path: Type.Optional(Type.String()),
  wall_time_seconds: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});

export const screenshot_output_schema = Type.Object({
  id: Type.String(),
  uid: Type.String(),
  width: Type.Number(),
  height: Type.Number(),
  image: Type.Object({
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
  }),
});
