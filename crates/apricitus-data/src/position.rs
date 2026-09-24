/// Fractional indexing: generate sortable string keys that position items between any two keys.
/// Based on https://github.com/rocicorp/fractional-indexing (MIT license)
/// Reference: https://observablehq.com/@dgreensp/implementing-fractional-indexing

use std::collections::HashMap;

const BASE_62_DIGITS: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE_52_DIGITS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Cache for digit lookups: maps each digit's char to its index
thread_local! {
    static DIGIT_INDEX_CACHE: std::cell::RefCell<HashMap<String, Vec<u8>>> =
        std::cell::RefCell::new(HashMap::new());
}

/// Get or create a digit index for fast lookup
fn get_digit_index(digits: &str) -> Vec<u8> {
    DIGIT_INDEX_CACHE.with(|cache| {
        let mut map = cache.borrow_mut();
        if let Some(idx) = map.get(digits) {
            idx.clone()
        } else {
            let mut index = vec![255u8; 256];
            for (i, ch) in digits.chars().enumerate() {
                if (ch as usize) < 256 {
                    index[ch as usize] = i as u8;
                }
            }
            map.insert(digits.to_string(), index.clone());
            index
        }
    })
}

/// Returns true if character codes are strictly ascending
fn is_strictly_ascending(s: &str) -> bool {
    let mut prev = 0u32;
    for ch in s.chars() {
        let code = ch as u32;
        if code <= prev {
            return false;
        }
        prev = code;
    }
    true
}

/// Returns true if all characters are single-byte
fn is_single_byte(s: &str) -> bool {
    s.chars().all(|ch| (ch as u32) < 256)
}

/// Validates a digit alphabet
fn validate_digits(digits: &str) -> Result<(), String> {
    if digits.len() < 2 || !is_strictly_ascending(digits) {
        return Err(format!(
            "digits must be at least 2 characters in strictly ascending order: {}",
            digits
        ));
    }
    if !is_single_byte(digits) {
        return Err(format!("digits must be single-byte: {}", digits));
    }
    Ok(())
}

/// Validates an integer-head alphabet (must be even length)
fn validate_int_digits(int_digits: &str) -> Result<(), String> {
    if int_digits.len() < 2 || int_digits.len() % 2 != 0 || !is_strictly_ascending(int_digits) {
        return Err(format!(
            "intDigits must be even length >= 2 and strictly ascending: {}",
            int_digits
        ));
    }
    if !is_single_byte(int_digits) {
        return Err(format!("intDigits must be single-byte: {}", int_digits));
    }
    Ok(())
}

/// Get the expected length of the integer part based on the head character
fn get_integer_length(head: char, int_digits: &str, int_lookup: &[u8]) -> Result<usize, String> {
    let head_code = head as usize;
    if head_code >= int_lookup.len() {
        return Err(format!("invalid head character: {}", head));
    }
    let idx = int_lookup[head_code];
    if idx == 255 || int_digits.chars().nth(idx as usize) != Some(head) {
        return Err(format!("invalid order key head: {}", head));
    }
    let half = int_digits.len() / 2;
    let len = if (idx as usize) < half {
        half - (idx as usize) + 1
    } else {
        (idx as usize) - half + 2
    };
    Ok(len)
}

/// Extract integer part from a key
fn get_integer_part<'a>(
    key: &'a str,
    int_digits: &str,
    int_lookup: &[u8],
) -> Result<&'a str, String> {
    if key.is_empty() {
        return Err("key is empty".to_string());
    }
    let head = key.chars().next().unwrap();
    let len = get_integer_length(head, int_digits, int_lookup)?;
    if len > key.len() {
        return Err(format!("key too short: {}", key));
    }
    Ok(&key[..len])
}

/// Check if key is the smallest integer
fn is_smallest_integer(int_part: &str, digits: &str, int_digits: &str) -> bool {
    if int_part.len() != 2 {
        return false;
    }
    let half = int_digits.len() / 2;
    let head = int_part.chars().next().unwrap();
    let zero = digits.chars().next().unwrap();

    int_digits
        .chars()
        .nth(half - 1)
        .map(|h| h == head && int_part.chars().nth(1) == Some(zero))
        .unwrap_or(false)
}

/// Validate an order key
fn validate_order_key(key: &str, digits: &str, int_digits: &str, int_lookup: &[u8]) -> Result<(), String> {
    let int_part = get_integer_part(key, int_digits, int_lookup)?;

    if is_smallest_integer(int_part, digits, int_digits) {
        return Err(format!("invalid order key: {}", key));
    }

    let frac_part = &key[int_part.len()..];
    let zero = digits.chars().next().unwrap();
    if frac_part.ends_with(zero) {
        return Err(format!("invalid order key (trailing zero): {}", key));
    }

    Ok(())
}

/// Increment an integer part
fn increment_integer(
    x: &str,
    digits: &str,
    lookup: &[u8],
    int_digits: &str,
    int_lookup: &[u8],
) -> Result<Option<String>, String> {
    // Validate the integer
    let head = x.chars().next().ok_or("empty string")?;
    let expected_len = get_integer_length(head, int_digits, int_lookup)?;
    if x.len() != expected_len {
        return Err(format!("invalid integer part: {}", x));
    }

    let zero = digits.chars().next().unwrap();
    let mut trailing = String::new();

    // Walk digits right-to-left, from position x.len()-1 down to 1
    let chars: Vec<char> = x.chars().collect();
    for i in (1..chars.len()).rev() {
        let ch_code = chars[i] as usize;
        if ch_code >= lookup.len() {
            return Err(format!("invalid digit: {}", chars[i]));
        }
        let d = lookup[ch_code] as usize + 1;
        if d == digits.len() {
            trailing.insert(0, zero);
        } else {
            // Found a digit we can increment
            let mut result = String::new();
            result.push(head);
            result.push_str(&x[1..i]);
            result.push(digits.chars().nth(d).unwrap());
            result.push_str(&trailing);
            return Ok(Some(result));
        }
    }

    // Carry out of the whole digit run; trailing is now all zeros
    let head_idx = int_lookup[head as usize] as usize;
    if head_idx == int_digits.len() - 1 {
        // Already at the largest integer
        return Ok(None);
    }

    let new_head = int_digits.chars().nth(head_idx + 1).unwrap();
    let new_len = get_integer_length(new_head, int_digits, int_lookup)?;
    let old_len = get_integer_length(head, int_digits, int_lookup)?;

    let length_delta = new_len as i32 - old_len as i32;

    let mut result = String::new();
    result.push(new_head);

    if length_delta > 0 {
        // Growing: append zero to trailing
        result.push_str(&trailing);
        result.push(zero);
    } else if length_delta < 0 {
        // Shrinking: remove first element from trailing
        if trailing.len() > 1 {
            result.push_str(&trailing[1..]);
        }
    } else {
        // Same length: use trailing as-is
        result.push_str(&trailing);
    }

    Ok(Some(result))
}

/// Decrement an integer part
fn decrement_integer(
    x: &str,
    digits: &str,
    lookup: &[u8],
    int_digits: &str,
    int_lookup: &[u8],
) -> Result<Option<String>, String> {
    let expected_len = get_integer_length(x.chars().next().unwrap(), int_digits, int_lookup)?;
    if x.len() != expected_len {
        return Err(format!("invalid integer part: {}", x));
    }

    let head = x.chars().next().unwrap();
    let _zero = digits.chars().next().unwrap();
    let max_digit = digits.chars().next_back().unwrap();

    let mut result = String::new();
    result.push(head);
    let mut prefix = String::new();

    let chars: Vec<char> = x.chars().collect();

    // Walk right to left looking for a digit we can decrement
    for i in (1..chars.len()).rev() {
        let ch_code = chars[i] as usize;
        if ch_code >= lookup.len() {
            return Err(format!("invalid digit: {}", chars[i]));
        }
        let d = lookup[ch_code] as usize;
        if d > 0 {
            result.push_str(&x[1..i]);
            result.push(digits.chars().nth(d - 1).unwrap());
            result.push_str(&prefix);
            return Ok(Some(result));
        } else {
            prefix.insert(0, max_digit);
        }
    }

    // Carry out: bump the head down
    let head_idx = int_lookup[head as usize] as usize;
    if head_idx == 0 {
        // Already at smallest head
        return Ok(None);
    }

    let new_head = int_digits.chars().nth(head_idx - 1).unwrap();
    let new_len = get_integer_length(new_head, int_digits, int_lookup)?;
    let old_len = get_integer_length(head, int_digits, int_lookup)?;

    let mut new_result = String::new();
    new_result.push(new_head);

    if new_len > old_len {
        // Growing: fill with max digits
        for _ in 0..(new_len - 1) {
            new_result.push(max_digit);
        }
    } else if new_len < old_len {
        // Shrinking: use max digit
        new_result.push(max_digit);
    } else {
        // Same length: fill with max digits
        for _ in 1..new_len {
            new_result.push(max_digit);
        }
    }

    Ok(Some(new_result))
}

/// Calculate the midpoint between two digit strings
fn midpoint(a: &str, b: Option<&str>, digits: &str, lookup: &[u8]) -> Result<String, String> {
    let zero = digits.chars().next().unwrap();

    if let Some(b_str) = b {
        if a >= b_str {
            return Err(format!("{} >= {}", a, b_str));
        }
    }

    if a.ends_with(zero) || b.map(|s| s.ends_with(zero)).unwrap_or(false) {
        return Err("trailing zero".to_string());
    }

    if let Some(b_str) = b {
        // Find common prefix and recurse
        let mut n = 0;
        let a_chars: Vec<char> = a.chars().collect();
        let b_chars: Vec<char> = b_str.chars().collect();

        while n < a_chars.len() || n < b_chars.len() {
            let a_ch = if n < a_chars.len() { a_chars[n] } else { zero };
            let b_ch = if n < b_chars.len() { b_chars[n] } else { break };
            if a_ch != b_ch {
                break;
            }
            n += 1;
        }

        if n > 0 {
            let mut result = String::new();
            for i in 0..n {
                result.push(b_chars[i]);
            }
            result.push_str(&midpoint(&a[n..], Some(&b_str[n..]), digits, lookup)?);
            return Ok(result);
        }
    }

    // First digits are different
    let digit_a = if !a.is_empty() {
        let ch = a.chars().next().unwrap() as usize;
        if ch >= lookup.len() {
            0
        } else {
            lookup[ch] as usize
        }
    } else {
        0
    };

    let digit_b = if let Some(b_str) = b {
        let ch = b_str.chars().next().unwrap() as usize;
        if ch >= lookup.len() {
            0
        } else {
            lookup[ch] as usize
        }
    } else {
        digits.len()
    };

    if digit_b - digit_a > 1 {
        let mid_digit = (digit_a + digit_b + 1) / 2;
        Ok(digits.chars().nth(mid_digit).unwrap().to_string())
    } else {
        // First digits are consecutive
        if let Some(b_str) = b {
            if b_str.len() > 1 {
                return Ok(b_str[..1].to_string());
            }
        }
        let first = digits.chars().nth(digit_a).unwrap().to_string();
        let rest = midpoint(&a[1..], None, digits, lookup)?;
        Ok(first + &rest)
    }
}

/// Generate a single key between two bounds
pub fn generate_key_between(
    a: Option<&str>,
    b: Option<&str>,
) -> Result<String, String> {
    generate_key_between_with_alphabets(a, b, None, None)
}

/// Generate a single key between two bounds with custom alphabets
pub fn generate_key_between_with_alphabets(
    a: Option<&str>,
    b: Option<&str>,
    digits: Option<&str>,
    int_digits: Option<&str>,
) -> Result<String, String> {
    let digits = digits.unwrap_or(BASE_62_DIGITS);
    let int_digits = int_digits.unwrap_or(BASE_52_DIGITS);

    validate_digits(digits)?;
    validate_int_digits(int_digits)?;

    let lookup = get_digit_index(digits);
    let int_lookup = get_digit_index(int_digits);

    if let Some(a_str) = a {
        validate_order_key(a_str, digits, int_digits, &int_lookup)?;
    }
    if let Some(b_str) = b {
        validate_order_key(b_str, digits, int_digits, &int_lookup)?;
    }

    let mut a = a;
    let mut b = b;

    // Swap if out of order
    if a.is_some() && b.is_some() && a.unwrap() > b.unwrap() {
        std::mem::swap(&mut a, &mut b);
    }

    match (a, b) {
        (None, None) => {
            // Return first key
            let head = int_digits
                .chars()
                .nth(int_digits.len() / 2)
                .ok_or("invalid int_digits")?;
            let zero = digits.chars().next().ok_or("invalid digits")?;
            Ok(format!("{}{}", head, zero))
        }
        (None, Some(b_str)) => {
            let ib = get_integer_part(b_str, int_digits, &int_lookup)?;
            let fb = &b_str[ib.len()..];

            if is_smallest_integer(ib, digits, int_digits) {
                let mid = midpoint("", Some(fb), digits, &lookup)?;
                Ok(format!("{}{}", ib, mid))
            } else if ib < b_str {
                Ok(ib.to_string())
            } else {
                let res = decrement_integer(ib, digits, &lookup, int_digits, &int_lookup)?;
                res.ok_or_else(|| "cannot decrement any more".to_string())
            }
        }
        (Some(a_str), None) => {
            let ia = get_integer_part(a_str, int_digits, &int_lookup)?;
            let fa = &a_str[ia.len()..];

            let i = increment_integer(ia, digits, &lookup, int_digits, &int_lookup)?;
            match i {
                Some(i_str) => Ok(i_str),
                None => {
                    let mid = midpoint(fa, None, digits, &lookup)?;
                    Ok(format!("{}{}", ia, mid))
                }
            }
        }
        (Some(a_str), Some(b_str)) => {
            let ia = get_integer_part(a_str, int_digits, &int_lookup)?;
            let fa = &a_str[ia.len()..];
            let ib = get_integer_part(b_str, int_digits, &int_lookup)?;
            let fb = &b_str[ib.len()..];

            if ia == ib {
                let mid = midpoint(fa, Some(fb), digits, &lookup)?;
                Ok(format!("{}{}", ia, mid))
            } else {
                let i = increment_integer(ia, digits, &lookup, int_digits, &int_lookup)?;
                match i {
                    Some(i_str) if i_str.as_str() < b_str => Ok(i_str),
                    Some(_) => {
                        let mid = midpoint(fa, None, digits, &lookup)?;
                        Ok(format!("{}{}", ia, mid))
                    }
                    None => Err("cannot increment any more".to_string()),
                }
            }
        }
    }
}

/// Generate multiple keys between two bounds
pub fn generate_n_keys_between(
    a: Option<&str>,
    b: Option<&str>,
    n: usize,
) -> Result<Vec<String>, String> {
    generate_n_keys_between_with_alphabets(a, b, n, None, None)
}

/// Generate multiple keys between two bounds with custom alphabets
pub fn generate_n_keys_between_with_alphabets(
    a: Option<&str>,
    b: Option<&str>,
    n: usize,
    digits: Option<&str>,
    int_digits: Option<&str>,
) -> Result<Vec<String>, String> {
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![generate_key_between_with_alphabets(a, b, digits, int_digits)?]);
    }

    match (a, b) {
        (_, None) => {
            let mut result = vec![generate_key_between_with_alphabets(a, b, digits, int_digits)?];
            for _ in 1..n {
                let c = result.last().unwrap().clone();
                let next = generate_key_between_with_alphabets(Some(&c), None, digits, int_digits)?;
                result.push(next);
            }
            Ok(result)
        }
        (None, Some(_)) => {
            let mut result = vec![generate_key_between_with_alphabets(a, b, digits, int_digits)?];
            for _ in 1..n {
                let c = result.last().unwrap().clone();
                let next = generate_key_between_with_alphabets(None, Some(&c), digits, int_digits)?;
                result.push(next);
            }
            result.reverse();
            Ok(result)
        }
        (Some(_), Some(_)) => {
            let mid = n / 2;
            let c = generate_key_between_with_alphabets(a, b, digits, int_digits)?;
            let mut result = generate_n_keys_between_with_alphabets(a, Some(&c), mid, digits, int_digits)?;
            result.push(c);
            let mut rest = generate_n_keys_between_with_alphabets(Some(&result.last().unwrap()), b, n - mid - 1, digits, int_digits)?;
            result.append(&mut rest);
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test vectors from rocicorp/fractional-indexing reference implementation
    // https://github.com/rocicorp/fractional-indexing/blob/main/src/test.js

    #[test]
    fn test_reference_vectors() {
        // Basic default alphabet cases (BASE_62_DIGITS with BASE_52_DIGITS heads)
        struct TestCase {
            a: Option<&'static str>,
            b: Option<&'static str>,
            expected: &'static str,
        }

        let cases = vec![
            TestCase { a: None, b: None, expected: "a0" },
            TestCase { a: None, b: Some("a0"), expected: "Zz" },
            TestCase { a: None, b: Some("Zz"), expected: "Zy" },
            TestCase { a: Some("a0"), b: None, expected: "a1" },
            TestCase { a: Some("a1"), b: None, expected: "a2" },
            TestCase { a: Some("a0"), b: Some("a1"), expected: "a0V" },
            TestCase { a: Some("a1"), b: Some("a2"), expected: "a1V" },
            TestCase { a: Some("a0V"), b: Some("a1"), expected: "a0l" },
            TestCase { a: Some("Zz"), b: Some("a0"), expected: "ZzV" },
            TestCase { a: Some("Zz"), b: Some("a1"), expected: "a0" },
            TestCase { a: None, b: Some("Y00"), expected: "Xzzz" },
            TestCase { a: Some("bzz"), b: None, expected: "c000" },
            TestCase { a: Some("a0"), b: Some("a0V"), expected: "a0G" },
            TestCase { a: Some("a0"), b: Some("a0G"), expected: "a08" },
            TestCase { a: Some("b125"), b: Some("b129"), expected: "b127" },
            TestCase { a: Some("a0"), b: Some("a1V"), expected: "a1" },
            TestCase { a: Some("Zz"), b: Some("a01"), expected: "a0" },
            TestCase { a: None, b: Some("a0V"), expected: "a0" },
            TestCase { a: None, b: Some("b999"), expected: "b99" },
        ];

        for (i, case) in cases.iter().enumerate() {
            let result = generate_key_between(case.a, case.b).unwrap_or_default();
            assert_eq!(
                result, case.expected,
                "case {}: between({:?}, {:?})",
                i, case.a, case.b
            );
        }
    }

    #[test]
    fn test_invalid_inputs() {
        // Trailing zero error
        assert!(
            generate_key_between(Some("a00"), None).is_err(),
            "trailing zero should error"
        );

        // Trailing zero in bound
        assert!(
            generate_key_between(Some("a00"), Some("a1")).is_err(),
            "trailing zero in bounds should error"
        );

        // Same bounds
        assert!(
            generate_key_between(Some("a0"), Some("a0")).is_err(),
            "same bounds should error"
        );

        // Invalid head (digit in head position for default alphabet)
        assert!(
            generate_key_between(Some("0a1"), None).is_err(),
            "invalid head should error"
        );
    }

    #[test]
    fn test_generate_n_keys() {
        let keys = generate_n_keys_between(None, None, 5).unwrap();
        assert_eq!(keys, vec!["a0", "a1", "a2", "a3", "a4"]);
    }

    #[test]
    fn test_generate_n_keys_base_10() {
        // Test with base-10 digits "0123456789" as both digits and intDigits
        let keys = generate_n_keys_between_with_alphabets(
            None,
            None,
            5,
            Some("0123456789"),
            Some("0123456789"),
        )
        .unwrap();
        assert_eq!(keys, vec!["50", "51", "52", "53", "54"]);
    }

    #[test]
    fn test_generate_n_keys_base_10_after_54() {
        // After 54, next 10 keys should be 55-59 then 600-604
        let keys = generate_n_keys_between_with_alphabets(
            Some("54"),
            None,
            10,
            Some("0123456789"),
            Some("0123456789"),
        )
        .unwrap();
        assert_eq!(
            keys,
            vec!["55", "56", "57", "58", "59", "600", "601", "602", "603", "604"]
        );
    }

    #[test]
    fn test_100_successive_keys() {
        let mut prev = generate_key_between(None, None).unwrap();
        for _ in 1..100 {
            let next = generate_key_between(Some(&prev), None).unwrap();
            assert!(prev < next, "keys not strictly increasing: {} >= {}", prev, next);
            prev = next;
        }
    }

    #[test]
    fn test_key_between_a0_and_a1() {
        let key = generate_key_between(Some("a0"), Some("a1")).unwrap();
        assert!(key.as_str() > "a0" && key.as_str() < "a1", "key not between bounds: {} not in ({}, {})", key, "a0", "a1");
        assert_eq!(key, "a0V");
    }

    #[test]
    fn test_a3_to_a4() {
        let key = generate_key_between(Some("a3"), None).unwrap();
        assert_eq!(key, "a4");
    }

    #[test]
    #[allow(non_snake_case)]
    fn test_a9_to_aA() {
        let key = generate_key_between(Some("a9"), None).unwrap();
        assert_eq!(key, "aA");
    }
}
