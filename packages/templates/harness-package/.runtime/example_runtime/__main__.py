import json
import sys


def main() -> None:
    value = ""
    args = sys.argv[1:]
    for index, item in enumerate(args):
        if item == "--value" and index + 1 < len(args):
            value = args[index + 1]
            break
    print(json.dumps({"value": value}))


if __name__ == "__main__":
    main()
