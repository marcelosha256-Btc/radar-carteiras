"""Rodar: python -m unittest tests/test_alertas.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "coletor"))
from alertas import avaliar


class Alertas(unittest.TestCase):
    def test_stop_e_alvo_da_compra(self):
        tr = [{"id": 1, "ativo": "BTC", "lado": "compra", "stop": 90, "alvo1": 120, "alvo2": 150}]
        self.assertEqual(avaliar(tr, {"BTC": "100"}, [], set())[0], [])
        n, f = avaliar(tr, {"BTC": "89.9"}, [], set())
        self.assertEqual(len(n), 1)
        self.assertIn("Stop", n[0])
        self.assertEqual(avaliar(tr, {"BTC": "89"}, [], f)[0], [])   # não repete
        n3, _ = avaliar(tr, {"BTC": "125"}, [], set())
        self.assertEqual(len(n3), 1)
        self.assertIn("Alvo 1", n3[0])

    def test_venda_e_acao_xyz(self):
        tr = [{"id": 2, "ativo": "NVDA", "lado": "venda", "stop": 110, "alvo1": 90, "alvo2": None}]
        self.assertEqual(len(avaliar(tr, {"xyz:NVDA": "111"}, [], set())[0]), 1)
        self.assertIn("Alvo 1", avaliar(tr, {"xyz:NVDA": "89"}, [], set())[0][0])
        self.assertEqual(avaliar(tr, {"xyz:NVDA": "100"}, [], set())[0], [])

    def test_liquidacao_com_histerese(self):
        q = [{"coin": "ETH", "lado": "compra", "liq": 1800.0, "dist": 0.05}]
        n, f = avaliar([], {}, q, set())
        self.assertEqual(len(n), 1)
        self.assertEqual(avaliar([], {}, q, f)[0], [])
        q[0]["dist"] = 0.10   # entre 8% e 12%: continua marcado como avisado
        self.assertIn("liq:ETH", avaliar([], {}, q, f)[1])
        q[0]["dist"] = 0.20   # afastou: rearma
        self.assertNotIn("liq:ETH", avaliar([], {}, q, f)[1])

    def test_poda_operacoes_fechadas(self):
        _, f = avaliar([], {}, [], {"t7:stop", "liq:BTC"})
        self.assertNotIn("t7:stop", f)
        self.assertIn("liq:BTC", f)


if __name__ == "__main__":
    unittest.main()
