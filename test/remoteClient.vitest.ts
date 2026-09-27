import { sessionContract } from "./support/sessionContract.ts"
import { hostedHarness } from "./support/host.ts"
sessionContract(1, hostedHarness, "remote", "live")
sessionContract(2, hostedHarness, "remote", "live")
