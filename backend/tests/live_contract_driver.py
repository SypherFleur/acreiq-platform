"""Private, stdin-only LiveTools driver for cross-language browser contract tests.

No HTTP server, provider connection, environment loading or media capture.
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.live_tools import LiveTools
from backend.core import Scenario
from backend.run_evidence import execute_run


async def main():
    tools = LiveTools()
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = json.loads(line)
        try:
            match request["op"]:
                case "optimize":
                    result = {"response": execute_run(Scenario.model_validate(request["scenario"]))}
                case "context":
                    result = {"events": tools.set_context(request["context"])}
                case "observe":
                    result = {"turn_id": tools.observe_user_transcript(request["text"])}
                case "dispatch":
                    response, events = await tools.dispatch(request["id"], request["name"], request.get("args", {}))
                    result = {"response": response, "events": events}
                case "ack":
                    response, events = tools.acknowledge(request["action_id"], request["status"], request["message"], request["context"])
                    result = {"response": response, "events": events}
                case "wait":
                    response, events = await tools.wait_action(request["action_id"], timeout=0.25)
                    result = {"response": response, "events": events}
                case _:
                    result = {"driver_error": "Unknown test operation"}
        except Exception as exc:
            result = {"driver_error": type(exc).__name__}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
