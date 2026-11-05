"""Only delete this run's private runner workspace and isolated container."""
import shutil
from common import Failure, run, workspace
from main import container_name

root = workspace()
try:
    run(['docker', 'rm', '--force', container_name()], timeout=60)
except Failure:
    pass
shutil.rmtree(root)
print('Removed this run workspace; GitHub-hosted runner disposal is the final cleanup boundary.')
