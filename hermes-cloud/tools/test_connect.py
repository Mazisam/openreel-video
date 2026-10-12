import unittest
from connect_hermes import merge,env_merge
import yaml

class ConfigPreservation(unittest.TestCase):
    def test_existing_provider_and_cafe_are_preserved(self):
        text='# owner comment\nmodel: claude-sonnet-4-6\nprovider: Antigravity Subscription DirectSDK\nmcp_servers:\n  japoni:\n    url: https://cafe.example/mcp # keep this comment\n  hermes_studio:\n    command: python3\n'
        result=merge(text,'https://render.example.com')
        self.assertIn('# owner comment',result);self.assertIn('# keep this comment',result)
        before=yaml.safe_load(text);after=yaml.safe_load(result)
        self.assertEqual(before['provider'],after['provider']);self.assertEqual(before['mcp_servers']['japoni'],after['mcp_servers']['japoni'])
        self.assertEqual(merge(result,'https://render.example.com'),result)
    def test_inline_yaml_is_not_rewritten(self):
        with self.assertRaises(ValueError): merge('mcp_servers: {}\n','https://render.example.com')
    def test_env_preserves_other_keys(self):
        self.assertEqual(env_merge('OTHER=1\nOPENREEL_SERVICE_TOKEN=old\n','new'),'OTHER=1\nOPENREEL_SERVICE_TOKEN=new\n')

if __name__=='__main__': unittest.main()
