if (!process.stdout.isTTY && !process.env.FORCE_COLOR)
  process.env.NO_COLOR = "1";
