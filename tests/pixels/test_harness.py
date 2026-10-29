"""CPU-only tests for the pixel gate; no adapter or graphics library needed."""
import struct
import unittest

from harness import HERE, NAMES, POLICY, compare, read_png, reference, verify_compute


class PixelHarnessTests(unittest.TestCase):
    def test_committed_pngs_match_independent_oracle(self):
        for name in NAMES:
            with self.subTest(name=name):
                width, height, pixels = read_png(HERE / 'expected' / (name + '.png'))
                self.assertEqual((width, height), (64, 64))
                self.assertEqual(pixels, reference(name))

    def test_tolerance_is_per_channel_including_alpha(self):
        expected = reference('clear')
        accepted = bytearray(expected)
        accepted[0] += 2
        accepted[3] -= 2
        self.assertEqual(compare('clear', expected, accepted)['different_pixels'], 0)
        accepted[3] -= 1
        with self.assertRaises(AssertionError):
            compare('clear', expected, accepted)

    def test_edge_pixels_are_not_ignored(self):
        expected = reference('triangle')
        actual = bytearray(expected)
        for x in range(49):
            actual[x * 4 + 3] = 0  # top boundary still consumes the finite budget
        with self.assertRaises(AssertionError):
            compare('triangle', expected, actual)

    def test_difference_cap_is_inclusive(self):
        for name in ('triangle', 'msaa'):
            expected = reference(name)
            actual = bytearray(expected)
            cap = POLICY[name][1]
            for pixel in range(cap):
                actual[pixel * 4 + 3] = 0
            self.assertEqual(compare(name, expected, actual)['different_pixels'], cap)
            actual[cap * 4 + 3] = 0
            with self.assertRaises(AssertionError):
                compare(name, expected, actual)

    def test_size_mismatch_fails(self):
        with self.assertRaises(AssertionError):
            compare('clear', reference('clear'), b'')

    def test_compute_checks_full_u32_not_only_visualized_channels(self):
        values = bytearray(b''.join(struct.pack('<I', i * 3 + 7) for i in range(4096)))
        verify_compute(values)
        values[3] = 1  # unchanged visualized low 16 bits; buffer must still fail
        with self.assertRaises(AssertionError):
            verify_compute(values)

    def test_reference_semantic_landmarks(self):
        def pixel(name, x, y):
            offset = (y * 64 + x) * 4
            return tuple(reference(name)[offset:offset + 4])
        self.assertEqual(pixel('triangle', 32, 32), (64, 191, 128, 255))
        self.assertEqual(pixel('triangle', 0, 0), (0, 0, 0, 255))
        self.assertEqual(pixel('instanced-rects', 1, 1), (0, 0, 0, 255))
        self.assertEqual(pixel('instanced-rects', 3, 3), (255, 128, 64, 255))
        self.assertEqual(pixel('compute', 63, 63), (4, 48, 0, 255))
        self.assertEqual(pixel('textured-quad', 63, 0), (0, 255, 0, 255))


if __name__ == '__main__':
    unittest.main()
