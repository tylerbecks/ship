// Every command, in the order `ship --help` lists them within each section.
// A new command group is a new file in src/commands plus one line here.

import type { Command } from "../command";
import { commands as api } from "./api";
import { commands as apps } from "./apps";
import { commands as archive } from "./archive";
import { commands as auth } from "./auth";
import { commands as beta } from "./beta";
import { commands as builds } from "./builds";
import { commands as devices } from "./devices";
import { commands as doctor } from "./doctor";
import { commands as feedback } from "./feedback";
import { commands as groups } from "./groups";
import { commands as init } from "./init";
import { commands as metadata } from "./metadata";
import { commands as open } from "./open";
import { commands as purchases } from "./purchases";
import { commands as release } from "./release";
import { commands as reviews } from "./reviews";
import { commands as sandbox } from "./sandbox";
import { commands as screenshots } from "./screenshots";
import { commands as secret } from "./secret";
import { commands as status } from "./status";
import { commands as subscriptions } from "./subscriptions";
import { commands as testers } from "./testers";
import { commands as testflight } from "./testflight";
import { commands as users } from "./users";
import { commands as version } from "./version";

export const commands: Command[] = [
  // Set up once per repo
  ...init,
  ...apps,
  ...auth,
  ...secret,
  ...doctor,
  // Every day
  ...status,
  ...beta,
  ...testers,
  ...archive,
  ...open,
  ...builds,
  // TestFlight
  ...groups,
  ...feedback,
  ...testflight,
  // App Store, in the order a release uses them
  ...version,
  ...metadata,
  ...screenshots,
  ...purchases,
  ...subscriptions,
  ...release,
  ...reviews,
  // Anything else
  ...users,
  ...devices,
  ...sandbox,
  ...api,
];
