import { sessionContract } from "./sessionClient.test.ts"
import { hostedHarness } from "./support/host.ts"
sessionContract(1, hostedHarness, "remote")
sessionContract(2, hostedHarness, "remote")
