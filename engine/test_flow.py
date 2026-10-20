"""The single generic test: pytest expands it into one test per flow step.

Run directly, without the UI:
    pytest engine/test_flow.py --flow flows/my-flow.json -s
    pytest engine/test_flow.py --flow flows/quotes-scraper.json --show-browser --slowmo 300
"""


def test_step(step, page, af):
    index, data = step
    af.run_step(page, index, data)
