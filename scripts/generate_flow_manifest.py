"""Generate source-derived public flow metadata without DB/API credentials."""
from app.infrastructure.flow_manifest import write_manifest


def main():
    manifest = write_manifest()
    print(f'Flow metadata generated: {len(manifest["nodes"])} nodes, {len(manifest["edges"])} relationships, source {manifest["sourceDigest"][:12]}')


if __name__ == '__main__':
    main()
