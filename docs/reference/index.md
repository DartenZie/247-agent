# Reference

The exhaustive tables. The guide pages explain; these pages list.

| Page | What it lists |
|---|---|
| [Command line](cli.md) | every `oa` command with its flags, output and exit codes; the daemon's and the connector host's flags; the environment variables |
| [`agent.yaml`](agent-yaml.md) | every key of the daemon's configuration with its default; providers and the built-in price table; what changes on reload |
| [Task](task.md) | the task envelope, the grammars for names, durations and event types, and every check `oa validate` performs on a tasks file |
| [Connector manifest](manifest.md) | every manifest field, the poller's configuration, the sandbox forms and the network allowlist grammar, what a connector process receives |
| [HTTP API](api.md) | every route on the Unix socket with its parameters, bodies and status codes; the record shapes |
| [Events and log lines](events.md) | the event record, the sources, every event the daemon publishes, how a run is started, and the log names worth searching for |
| [Metrics](metrics.md) | every `oa_` metric with its type and labels, and how to scrape them |
| [Glossary](glossary.md) | the words this documentation uses |

The fields of each action live on that action's page under [Tasks](../tasks/index.md);
the configuration of each connector on its page under [Connectors](../connectors/index.md).
