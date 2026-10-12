"""Offline check: python3 scripts/check-seedream-references.py <staged-ppt-master>."""
import base64
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(sys.argv[1]).resolve() / 'scripts'))
# No HTTP requests are made by this check.
requests_stub = types.ModuleType('requests')
requests_stub.Response = object
sys.modules.setdefault('requests', requests_stub)
from image_backends import backend_openai as backend


def rejects(call):
    try:
        call()
    except ValueError:
        return
    raise AssertionError('Expected invalid reference to be rejected')


assert backend._seedream_reference_limit('doubao-seedream-5-0-pro') == 10
assert backend._seedream_reference_limit('doubao-seedream-5-0-flash') == 10
assert backend._seedream_reference_limit('doubao-seedream-4-5') == 14
with tempfile.TemporaryDirectory() as directory:
    image = Path(directory) / 'reference.png'
    Image.new('RGB', (32, 32)).save(image)
    refs = [str(image), str(image)]
    with patch.object(backend, '_post_image_generation', return_value={
        'data': [{'b64_json': base64.b64encode(image.read_bytes()).decode()}]
    }) as post:
        output = backend._generate_image('test', 'preserve the spacecraft',
            model='doubao-seedream-5-0-pro', output_dir=directory,
            reference_images=refs)
        request = post.call_args.args[2]
        assert len(request['image']) == 2
        assert all(ref.startswith('data:image/png;base64,') for ref in request['image'])
        assert Path(output).exists()
    rejects(lambda: backend._generate_image('test', 'test',
        model='doubao-seedream-5-0-pro', reference_images=refs * 6))
    Image.new('RGB', (14, 32)).save(image)
    rejects(lambda: backend._reference_image_data(str(image)))
    with image.open('wb') as oversized:
        oversized.truncate(30 * 1024 * 1024 + 1)
    rejects(lambda: backend._reference_image_data(str(image)))
print('Seedream reference payload and limits passed')
