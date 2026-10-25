// Plain structs: pub, named pub fields, no attributes needed; the wrapper mirrors them with repr(C).
pub struct Point {
    pub x: i32,
    pub y: i64,
}

pub struct Named {
    pub name: String,
    pub at: Point,
}

pub fn shift(p: Point, dx: i32) -> Point {
    Point { x: p.x + dx, y: p.y }
}

pub fn rename(n: Named, name: &str) -> Named {
    Named { name: name.to_owned(), at: n.at }
}

pub fn dist(a: &Point, b: &Point) -> f64 {
    (((a.x - b.x) as f64).powi(2) + ((a.y - b.y) as f64).powi(2)).sqrt()
}
