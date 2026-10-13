A **factor tree** breaks a number into smaller factors until you are left with **only prime numbers**.

### Method 1: Pick any factor pair

Find **two numbers that multiply to make your number**.

Example:

```text
             24
            /  \
         6       4       ← factor pairs
        / \     / \
       2   3   2   2     ← prime numbers
```

The **leaves** are the numbers at the ends of the tree.

So:

**24 = 2 × 2 × 2 × 3**

---

### Method 2: Keep dividing by small primes

Start with the smallest prime that divides the number.

Example:

```text
60 ÷ 2 = 30
30 ÷ 2 = 15
15 ÷ 3 = 5
```

Since **5 is prime**, stop.

Therefore:

**60 = 2 × 2 × 3 × 5**

---

### Important rule

It does **not matter which factor pair you choose**.

As long as you keep splitting until **all the leaves are prime**, you will get the same prime factorisation.

**Factor pair → split → split → stop when everything is prime**